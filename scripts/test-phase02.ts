/**
 * StudyMeet — Phase 2 Test Suite
 *
 * Covers every rule from PRD §6.2 (DB-only tests) and §6.2a (required
 * automated tests). Run this after every `db reset + seed:users`.
 *
 * Usage:
 *   npm run test:phase2
 */

import dotenv from "dotenv";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

dotenv.config({ path: ".env.local" });

const LOCAL_URL = "http://127.0.0.1:54321";
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!ANON_KEY || !SERVICE_KEY) {
  console.error(
    "Missing env vars — check .env.local for NEXT_PUBLIC_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY",
  );
  process.exit(1);
}

// Service-role client: bypasses RLS, used only for test setup/teardown and
// reading hidden state (e.g. confirming a trigger fired correctly).
const admin = createClient(LOCAL_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Course IDs — must match supabase/seed.sql exactly.
const COURSE = {
  CSC148: "00000000-0000-0000-0000-000000000001",
  CSC207: "00000000-0000-0000-0000-000000000002",
  CSC258: "00000000-0000-0000-0000-000000000003",
  CSC263: "00000000-0000-0000-0000-000000000004",
  MAT102: "00000000-0000-0000-0000-000000000005",
  MAT232: "00000000-0000-0000-0000-000000000006",
  STA256: "00000000-0000-0000-0000-000000000007",
};

// ─── Test runner ────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, name: string, detail?: string) {
  if (condition) {
    console.log(`    ✓  ${name}`);
    passed++;
  } else {
    const msg = detail ? `${name}  →  ${detail}` : name;
    console.log(`    ✗  ${msg}`);
    failed++;
    failures.push(msg);
  }
}

function section(label: string) {
  console.log(`\n  ${label}`);
  console.log(`  ${"─".repeat(label.length)}`);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

type UserHandle = { client: SupabaseClient; userId: string };

async function signInAs(
  email: string,
  password = "testpassword123",
): Promise<UserHandle> {
  // Temporary client just to authenticate — not used after this function.
  const temp = createClient(LOCAL_URL, ANON_KEY, {
    auth: { persistSession: false },
  });
  const { data, error } = await temp.auth.signInWithPassword({
    email,
    password,
  });
  if (error || !data.session) {
    throw new Error(
      `Sign-in failed for ${email}: ${error?.message ?? "no session"}`,
    );
  }
  // Create a permanent client locked to this user's JWT.
  const client = createClient(LOCAL_URL, ANON_KEY, {
    global: {
      headers: { Authorization: `Bearer ${data.session.access_token}` },
    },
    auth: { persistSession: false },
  });
  return { client, userId: data.user!.id };
}

// All sessions created during tests are tracked here so cleanup() can delete
// them at the end regardless of test outcomes.
const createdSessionIds: string[] = [];

async function makeSession(
  asUser: UserHandle,
  overrides: Record<string, unknown> = {},
): Promise<{ data: Record<string, any> | null; error: any }> {
  const base = {
    host_id: asUser.userId,
    course_id: COURSE.CSC207,
    starts_at: future(24),
    ends_at: future(26),
    location: "Library",
    spots_total: 3,
    gender_preference: "open_to_all",
  };
  const { data, error } = await asUser.client
    .from("study_sessions")
    .insert({ ...base, ...overrides })
    .select()
    .single();
  if (data?.id) createdSessionIds.push(data.id);
  return { data, error };
}

// Inserts a session directly via admin (bypasses RLS + most triggers).
// Use this only for setting up state that can't go through the normal path
// (e.g. a session with a past ends_at to test the grace-period boundary).
async function adminInsertSession(
  fields: Record<string, unknown>,
): Promise<string | null> {
  const { data, error } = await admin
    .from("study_sessions")
    .insert(fields)
    .select("id")
    .single();
  if (error || !data) return null;
  createdSessionIds.push(data.id);
  return data.id;
}

async function cleanup() {
  if (createdSessionIds.length > 0) {
    await admin.from("study_sessions").delete().in("id", createdSessionIds);
  }
}

const future = (hrs: number) =>
  new Date(Date.now() + hrs * 3_600_000).toISOString();
const past = (hrs: number) =>
  new Date(Date.now() - hrs * 3_600_000).toISOString();

// ─── Test groups ─────────────────────────────────────────────────────────────

/**
 * Group 1 — RLS: Gender + Course Visibility
 * PRD §3.3, §3.7, SEC-2, SEC-2b
 *
 * None of these use RPC — they're raw SELECT queries against study_sessions.
 * If a row comes back that shouldn't, RLS is broken.
 */
async function testRLSVisibility(u: Record<string, UserHandle>) {
  section("1 · RLS — Gender & Course Visibility");

  // Set up reference sessions via admin so we don't burn through
  // alice/carol's host cap during setup.
  const womenId = await adminInsertSession({
    host_id: u.alice.userId,
    course_id: COURSE.CSC207,
    starts_at: future(100),
    ends_at: future(102),
    location: "Library",
    spots_total: 3,
    spots_remaining: 2,
    gender_preference: "women_only",
    status: "upcoming",
  });
  const menId = await adminInsertSession({
    host_id: u.bob.userId,
    course_id: COURSE.CSC207,
    starts_at: future(110),
    ends_at: future(112),
    location: "Library",
    spots_total: 3,
    spots_remaining: 2,
    gender_preference: "men_only",
    status: "upcoming",
  });
  // Session for CSC263 — dana is enrolled, others are not.
  const csc263Id = await adminInsertSession({
    host_id: u.dana.userId,
    course_id: COURSE.CSC263,
    starts_at: future(120),
    ends_at: future(122),
    location: "Library",
    spots_total: 3,
    spots_remaining: 2,
    gender_preference: "open_to_all",
    status: "upcoming",
  });

  // Male user cannot see women_only
  if (womenId) {
    const { data } = await u.bob.client
      .from("study_sessions")
      .select("id")
      .eq("id", womenId);
    assert(data?.length === 0, "Male user cannot see women_only session");
  }

  // PNS user cannot see women_only
  if (womenId) {
    const { data } = await u.sam.client
      .from("study_sessions")
      .select("id")
      .eq("id", womenId);
    assert(data?.length === 0, "PNS user cannot see women_only session");
  }

  // PNS user cannot see men_only
  if (menId) {
    const { data } = await u.sam.client
      .from("study_sessions")
      .select("id")
      .eq("id", menId);
    assert(data?.length === 0, "PNS user cannot see men_only session");
  }

  // Female user CAN see women_only (enrolled in CSC207)
  if (womenId) {
    const { data } = await u.carol.client
      .from("study_sessions")
      .select("id")
      .eq("id", womenId);
    assert(
      data?.length === 1,
      "Female user (enrolled in course) CAN see women_only session",
    );
  }

  // Male user CAN see men_only (enrolled in CSC207)
  if (menId) {
    const { data } = await u.bob.client
      .from("study_sessions")
      .select("id")
      .eq("id", menId);
    assert(
      data?.length === 1,
      "Male user (enrolled in course) CAN see men_only session",
    );
  }

  // User not enrolled in CSC263 cannot see that session
  if (csc263Id) {
    const { data: bobSees } = await u.bob.client
      .from("study_sessions")
      .select("id")
      .eq("id", csc263Id);
    const { data: carolSees } = await u.carol.client
      .from("study_sessions")
      .select("id")
      .eq("id", csc263Id);
    assert(
      bobSees?.length === 0,
      "User not enrolled in CSC263 cannot see its sessions (bob)",
    );
    assert(
      carolSees?.length === 0,
      "User not enrolled in CSC263 cannot see its sessions (carol)",
    );
  }

  // Dana IS enrolled in CSC263 and CAN see it
  if (csc263Id) {
    const { data } = await u.dana.client
      .from("study_sessions")
      .select("id")
      .eq("id", csc263Id);
    assert(
      data?.length === 1,
      "User enrolled in CSC263 CAN see its sessions (dana)",
    );
  }
}

/**
 * Group 2 — Session Creation Triggers
 * PRD §3.2, triggers: check_session_starts_in_future, check_course_enrollment,
 * check_booking_fields_required, auto_add_host_to_members
 */
async function testSessionCreation(u: Record<string, UserHandle>) {
  section("2 · Session Creation Triggers");

  // Valid session
  const { data: valid, error: validErr } = await makeSession(u.bob, {
    starts_at: future(200),
    ends_at: future(202),
  });
  assert(!validErr && !!valid, "Valid session creates successfully");

  if (valid) {
    const { data: membership } = await admin
      .from("session_members")
      .select()
      .eq("session_id", valid.id)
      .eq("user_id", u.bob.userId)
      .single();
    assert(
      !!membership,
      "Host auto-added to session_members (auto_add_host_to_members trigger)",
    );

    const { data: session } = await admin
      .from("study_sessions")
      .select("spots_total, spots_remaining")
      .eq("id", valid.id)
      .single();
    assert(
      session?.spots_remaining === session?.spots_total - 1,
      "spots_remaining = spots_total − 1 immediately after creation",
    );
  }

  // Past start time
  const { error: pastErr } = await makeSession(u.bob, {
    starts_at: past(1),
    ends_at: past(0.5),
  });
  assert(
    !!pastErr,
    "Past start time rejected (check_session_starts_in_future)",
  );

  // Non-enrolled course (bob is not in CSC263)
  const { error: courseErr } = await makeSession(u.bob, {
    course_id: COURSE.CSC263,
    starts_at: future(210),
    ends_at: future(212),
  });
  assert(!!courseErr, "Non-enrolled course rejected (check_course_enrollment)");

  // spots_total below minimum
  const { error: tooFewErr } = await makeSession(u.bob, {
    spots_total: 1,
    starts_at: future(220),
    ends_at: future(222),
  });
  assert(!!tooFewErr, "spots_total = 1 rejected (CHECK constraint)");

  // spots_total above maximum
  const { error: tooManyErr } = await makeSession(u.bob, {
    spots_total: 7,
    starts_at: future(230),
    ends_at: future(232),
  });
  assert(!!tooManyErr, "spots_total = 7 rejected (CHECK constraint)");

  // UTM booking checked but fields missing
  const { error: bookingErr } = await makeSession(u.bob, {
    utm_booking_included: true,
    booking_name: null,
    booking_room: null,
    booking_building: null,
    starts_at: future(240),
    ends_at: future(242),
  });
  assert(
    !!bookingErr,
    "UTM booking without required fields rejected (check_booking_fields_required)",
  );

  // UTM booking with all fields present
  const { error: validBookingErr } = await makeSession(u.bob, {
    utm_booking_included: true,
    booking_name: "Study Room A",
    booking_room: "MN2130",
    booking_building: "Maanjiwe nendamowinan",
    starts_at: future(250),
    ends_at: future(252),
  });
  assert(!validBookingErr, "UTM booking with all required fields accepted");
}

/**
 * Group 3 — Host Cap
 * PRD SESSION-CAP-1, enforce_host_cap_limit trigger
 * Default n_host_cap = 2.
 */
async function testHostCap(u: Record<string, UserHandle>) {
  section("3 · Host Cap (n_host_cap = 2)");

  // Explicitly set cap to 2 for this test, isolated from the global 99.
  // Sam has 0 hosted sessions at this point — safe to use.
  await admin.from("app_settings").update({ n_host_cap: 2 }).eq("id", 1);

  // Sam starts with 0 hosted sessions — safe to use here without
  // worrying about prior test pollution.
  const s1 = await makeSession(u.sam, {
    course_id: COURSE.CSC207,
    starts_at: future(300),
    ends_at: future(302),
  });
  const s2 = await makeSession(u.sam, {
    course_id: COURSE.STA256,
    starts_at: future(310),
    ends_at: future(312),
  });
  assert(!s1.error, "1st hosted session accepted (under cap)");
  assert(!s2.error, "2nd hosted session accepted (at cap)");

  const s3 = await makeSession(u.sam, {
    course_id: COURSE.CSC207,
    starts_at: future(320),
    ends_at: future(322),
  });
  assert(!!s3.error, "3rd hosted session rejected (enforce_host_cap_limit)");

  // Restore so subsequent groups aren't blocked.
  await admin.from("app_settings").update({ n_host_cap: 99 }).eq("id", 1);
}

/**
 * Group 4 — Schedule Overlap
 * PRD SESSION-OVERLAP, enforce_create_session_constraints trigger
 */
async function testScheduleOverlap(u: Record<string, UserHandle>) {
  section("4 · Schedule Overlap");

  // Dana creates a base session 400–402 hrs from now.
  const base = await makeSession(u.dana, {
    course_id: COURSE.CSC263,
    starts_at: future(400),
    ends_at: future(402),
  });
  assert(!base.error, "Base session created");

  // Overlapping window (401–403) rejected.
  const overlap = await makeSession(u.dana, {
    course_id: COURSE.MAT232,
    starts_at: future(401),
    ends_at: future(403),
  });
  assert(!!overlap.error, "Overlapping session creation rejected");

  // Non-overlapping window (403–405) accepted.
  const noOverlap = await makeSession(u.dana, {
    course_id: COURSE.MAT232,
    starts_at: future(403),
    ends_at: future(405),
  });
  assert(!noOverlap.error, "Non-overlapping session creation accepted");
}

/**
 * Group 5 — join_session RPC: Eligibility & Capacity
 * PRD §3.4, §5.3 — all checks inside the SECURITY DEFINER function.
 * §6.2a: Eligibility checks under direct API calls.
 */
async function testJoinSession(u: Record<string, UserHandle>) {
  section("5 · join_session RPC — Eligibility & Capacity");

  // Bob creates a 2-spot open session (CSC207 — bob, carol, sam all enrolled).
  const { data: openSession } = await makeSession(u.bob, {
    spots_total: 2,
    gender_preference: "open_to_all",
    starts_at: future(500),
    ends_at: future(502),
  });

  if (openSession) {
    // Carol can join (female, enrolled in CSC207)
    const { error: joinOk } = await u.carol.client.rpc("join_session", {
      p_session_id: openSession.id,
    });
    assert(!joinOk, "Eligible user joins open session");

    // Verify spots decremented and status flipped to full
    const { data: s } = await admin
      .from("study_sessions")
      .select("spots_remaining, status")
      .eq("id", openSession.id)
      .single();
    assert(
      s?.spots_remaining === 0,
      "spots_remaining = 0 after last spot taken",
    );
    assert(s?.status === "full", "Status becomes 'full' at capacity");

    // Duplicate join rejected
    const { error: dupErr } = await u.carol.client.rpc("join_session", {
      p_session_id: openSession.id,
    });
    assert(!!dupErr, "Duplicate join rejected");

    // Session is full — sam can't join even though eligible
    const { error: fullErr } = await u.sam.client.rpc("join_session", {
      p_session_id: openSession.id,
    });
    assert(!!fullErr, "Join rejected when session is full");
  }

  // Bob creates a women_only session for CSC207.
  const { data: womenSession } = await makeSession(u.bob, {
    spots_total: 3,
    gender_preference: "women_only",
    starts_at: future(510),
    ends_at: future(512),
  });
  if (womenSession) {
    const { error: samErr } = await u.sam.client.rpc("join_session", {
      p_session_id: womenSession.id,
    });
    assert(
      !!samErr,
      "PNS user rejected from women_only session (join_session gender check)",
    );

    const { error: carolOk } = await u.carol.client.rpc("join_session", {
      p_session_id: womenSession.id,
    });
    assert(!carolOk, "Female user accepted into women_only session");
  }

  // Bob creates a men_only session for CSC207.
  const { data: menSession } = await makeSession(u.bob, {
    spots_total: 3,
    gender_preference: "men_only",
    starts_at: future(520),
    ends_at: future(522),
  });
  if (menSession) {
    const { error: carolErr } = await u.carol.client.rpc("join_session", {
      p_session_id: menSession.id,
    });
    assert(!!carolErr, "Female user rejected from men_only session");

    const { error: samErr } = await u.sam.client.rpc("join_session", {
      p_session_id: menSession.id,
    });
    assert(!!samErr, "PNS user rejected from men_only session");
  }

  // Course enrollment: dana is NOT enrolled in CSC207.
  const { data: courseSession } = await makeSession(u.bob, {
    spots_total: 3,
    starts_at: future(530),
    ends_at: future(532),
  });
  if (courseSession) {
    const { error: danaErr } = await u.dana.client.rpc("join_session", {
      p_session_id: courseSession.id,
    });
    assert(
      !!danaErr,
      "User not enrolled in course cannot join (join_session course check)",
    );
  }

  // Schedule overlap: sam joins a session 540–542, then tries to join one at 541–543.
  const { data: samBase } = await makeSession(u.bob, {
    spots_total: 3,
    course_id: COURSE.CSC207,
    starts_at: future(540),
    ends_at: future(542),
  });
  const { data: samOverlap } = await makeSession(u.alice, {
    spots_total: 3,
    course_id: COURSE.CSC207,
    starts_at: future(541),
    ends_at: future(543),
  });
  if (samBase && samOverlap) {
    await u.sam.client.rpc("join_session", { p_session_id: samBase.id });
    const { error: overlapErr } = await u.sam.client.rpc("join_session", {
      p_session_id: samOverlap.id,
    });
    assert(!!overlapErr, "join_session rejects schedule overlap");
  }
}

/**
 * Group 6 — Race Condition: Concurrent Joins
 * PRD §6.2a — "exactly one succeeds, spots_remaining never goes negative"
 * join_session uses SELECT ... FOR UPDATE to serialize concurrent requests.
 */
async function testConcurrentJoins(u: Record<string, UserHandle>) {
  section("6 · Race Condition — Concurrent Joins (§6.2a)");

  // 2-spot session: host takes 1, exactly 1 spot left.
  // carol and sam both try to grab it at the same time.
  const { data: raceSession } = await makeSession(u.bob, {
    spots_total: 2,
    course_id: COURSE.CSC207,
    starts_at: future(600),
    ends_at: future(602),
  });

  if (raceSession) {
    const [r1, r2] = await Promise.allSettled([
      u.carol.client.rpc("join_session", { p_session_id: raceSession.id }),
      u.sam.client.rpc("join_session", { p_session_id: raceSession.id }),
    ]);

    const successes = [r1, r2].filter(
      (r) => r.status === "fulfilled" && !(r as any).value?.error,
    );
    const rejections = [r1, r2].filter(
      (r) => r.status === "rejected" || (r as any).value?.error,
    );

    assert(
      successes.length === 1,
      `Exactly 1 concurrent join succeeds (got ${successes.length})`,
    );
    assert(
      rejections.length === 1,
      `Exactly 1 concurrent join is rejected (got ${rejections.length})`,
    );

    const { data: s } = await admin
      .from("study_sessions")
      .select("spots_remaining")
      .eq("id", raceSession.id)
      .single();
    assert(
      s?.spots_remaining === 0,
      "spots_remaining = 0 (never went negative)",
    );
    assert((s?.spots_remaining ?? -1) >= 0, "spots_remaining is non-negative");
  }
}

/**
 * Group 7 — Member Departure: Spot Restore, Succession & Deletion
 * PRD §3.5.2, §3.5.4, handle_session_member_departure trigger.
 * §6.2a: Host departure and succession, including all-members-left case.
 */
async function testMemberDeparture(u: Record<string, UserHandle>) {
  section("7 · Member Departure — Succession & Session Deletion (§6.2a)");

  // ── 7a: Leaving restores spot and reverts full → upcoming ──
  // 2-spot session: bob hosts (1 spot left), carol joins (0 spots, full).
  const { data: spotSession } = await makeSession(u.bob, {
    spots_total: 2,
    course_id: COURSE.CSC207,
    starts_at: future(700),
    ends_at: future(702),
  });
  if (spotSession) {
    await u.carol.client.rpc("join_session", { p_session_id: spotSession.id });

    const { data: beforeLeave } = await admin
      .from("study_sessions")
      .select("spots_remaining, status")
      .eq("id", spotSession.id)
      .single();
    assert(
      beforeLeave?.status === "full",
      "Session is 'full' after both spots taken",
    );

    // Carol leaves.
    await admin
      .from("session_members")
      .delete()
      .eq("session_id", spotSession.id)
      .eq("user_id", u.carol.userId);

    const { data: afterLeave } = await admin
      .from("study_sessions")
      .select("spots_remaining, status")
      .eq("id", spotSession.id)
      .single();
    assert(
      afterLeave?.spots_remaining === 1,
      "spots_remaining restored to 1 after member leaves",
    );
    assert(
      afterLeave?.status === "upcoming",
      "Status reverts to 'upcoming' when spot opens",
    );
  }

  // ── 7b: Host succession ──
  // Bob hosts, carol joins first, sam joins second.
  // Bob leaves → carol (earliest joined_at) should become host.
  const { data: successionSession } = await makeSession(u.bob, {
    spots_total: 3,
    course_id: COURSE.CSC207,
    starts_at: future(710),
    ends_at: future(712),
  });
  if (successionSession) {
    await u.carol.client.rpc("join_session", {
      p_session_id: successionSession.id,
    });
    // Small delay so joined_at timestamps are distinct.
    await new Promise((r) => setTimeout(r, 50));
    await u.sam.client.rpc("join_session", {
      p_session_id: successionSession.id,
    });

    // Bob (host) leaves.
    await admin
      .from("session_members")
      .delete()
      .eq("session_id", successionSession.id)
      .eq("user_id", u.bob.userId);

    const { data: after } = await admin
      .from("study_sessions")
      .select("host_id")
      .eq("id", successionSession.id)
      .single();

    assert(
      after?.host_id === u.carol.userId,
      "Host transferred to earliest-joined remaining member (carol)",
    );
    assert(
      after?.host_id !== u.bob.userId,
      "Original host is no longer host_id",
    );

    // Former host tries to edit — RLS silently updates 0 rows, not an error.
    // Verify the value didn't actually change instead.
    await u.bob.client
      .from("study_sessions")
      .update({ note: "injected by former host" })
      .eq("id", successionSession.id);

    const { data: sessionAfterEdit } = await admin
      .from("study_sessions")
      .select("note, host_id")
      .eq("id", successionSession.id)
      .single();

    assert(
      sessionAfterEdit?.note !== "injected by former host",
      "Former host cannot edit session (sessions_update_policy — value unchanged)",
    );
  }

  // ── 7c: Session deleted when last member leaves ──
  const { data: soloSession } = await makeSession(u.bob, {
    spots_total: 2,
    course_id: COURSE.CSC207,
    starts_at: future(720),
    ends_at: future(722),
  });
  if (soloSession) {
    // Bob is the only member — remove him.
    await admin
      .from("session_members")
      .delete()
      .eq("session_id", soloSession.id)
      .eq("user_id", u.bob.userId);

    const { data: gone } = await admin
      .from("study_sessions")
      .select("id")
      .eq("id", soloSession.id);
    assert(
      !gone || gone.length === 0,
      "Session row deleted when last member leaves (§3.5.4)",
    );

    // Remove from tracking since it's already gone.
    const idx = createdSessionIds.indexOf(soloSession.id);
    if (idx >= 0) createdSessionIds.splice(idx, 1);
  }
}

/**
 * Group 8 — Cancellation Protection
 * PRD §3.5.3, enforce_cancellation_protection trigger.
 * §6.2a: "Cancellation rejected once accepted members > 1."
 */
async function testCancellationProtection(u: Record<string, UserHandle>) {
  section("8 · Cancellation Protection (§6.2a)");

  // Solo host can cancel their own session.
  const { data: solo } = await makeSession(u.alice, {
    course_id: COURSE.CSC207,
    starts_at: future(800),
    ends_at: future(802),
  });
  if (solo) {
    const { error } = await u.alice.client
      .from("study_sessions")
      .update({ status: "cancelled" })
      .eq("id", solo.id);
    assert(!error, "Host can cancel session while sole member");
  }

  // Group session: host cannot cancel once a 2nd member has joined.
  const { data: group } = await makeSession(u.alice, {
    spots_total: 3,
    course_id: COURSE.CSC207,
    starts_at: future(810),
    ends_at: future(812),
  });
  if (group) {
    await u.carol.client.rpc("join_session", { p_session_id: group.id });

    // Via user client (application layer)
    const { error: userErr } = await u.alice.client
      .from("study_sessions")
      .update({ status: "cancelled" })
      .eq("id", group.id);
    assert(!!userErr, "Direct cancel with 2+ members rejected (user client)");

    // Via admin/service-role (bypasses RLS but trigger still fires)
    const { error: adminErr } = await admin
      .from("study_sessions")
      .update({ status: "cancelled" })
      .eq("id", group.id);
    assert(
      !!adminErr,
      "Direct cancel with 2+ members rejected even via direct API call (trigger)",
    );
  }
}

/**
 * Group 9 — Suspension Enforcement
 * PRD §3.9, §3.9.2, handle_new_suspension trigger, one-pending-appeal index.
 * §6.2a: "Suspension effects — create/join/chat blocked."
 */
async function testSuspension(u: Record<string, UserHandle>) {
  section("9 · Suspension — Cascade, Enforcement & Appeal (§6.2a)");

  // Create an active session for carol before she's suspended.
  const { data: carolSession } = await makeSession(u.carol, {
    course_id: COURSE.CSC207,
    starts_at: future(900),
    ends_at: future(902),
  });

  // Suspend carol via admin.
  const { error: suspendErr } = await admin.from("suspensions").insert({
    user_id: u.carol.userId,
    admin_id: u.alice.userId,
    severity: "standard",
    reason: "Phase 2 test suspension",
    ends_at: future(24 * 7), // 1 week
  });
  assert(!suspendErr, "Admin can insert a suspension");

  // Trigger should have set is_suspended = true.
  const { data: carolUser } = await admin
    .from("users")
    .select("is_suspended")
    .eq("id", u.carol.userId)
    .single();
  assert(
    carolUser?.is_suspended === true,
    "handle_new_suspension sets is_suspended = true",
  );

  // Carol should have been removed from her active session.
  if (carolSession) {
    const { data: membership } = await admin
      .from("session_members")
      .select()
      .eq("session_id", carolSession.id)
      .eq("user_id", u.carol.userId);
    assert(
      !membership || membership.length === 0,
      "Suspended user removed from active sessions (cascade)",
    );
  }

  // Suspended carol cannot join a new session.
  const { data: joinTarget } = await makeSession(u.bob, {
    spots_total: 3,
    course_id: COURSE.CSC207,
    starts_at: future(910),
    ends_at: future(912),
  });
  if (joinTarget) {
    const { error: joinErr } = await u.carol.client.rpc("join_session", {
      p_session_id: joinTarget.id,
    });
    assert(
      !!joinErr,
      "Suspended user cannot join a session (join_session suspension gate)",
    );
  }

  // Suspended carol cannot create a session (RLS INSERT policy).
  const { error: createErr } = await makeSession(u.carol, {
    course_id: COURSE.CSC207,
    starts_at: future(920),
    ends_at: future(922),
  });
  assert(
    !!createErr,
    "Suspended user cannot create a session (sessions_insert_policy)",
  );

  // Suspended carol cannot send a chat message.
  // We need a session she has (or had) membership in — use joinTarget with admin.
  if (joinTarget) {
    await admin
      .from("session_members")
      .insert({ session_id: joinTarget.id, user_id: u.carol.userId });
    const { error: msgErr } = await u.carol.client.from("messages").insert({
      session_id: joinTarget.id,
      sender_id: u.carol.userId,
      content: "test message",
    });
    assert(
      !!msgErr,
      "Suspended user cannot send a message (messages_insert_policy)",
    );
    // Clean up the manually-inserted membership.
    await admin
      .from("session_members")
      .delete()
      .eq("session_id", joinTarget.id)
      .eq("user_id", u.carol.userId);
  }

  // ── Appeals ──
  const { data: suspension } = await admin
    .from("suspensions")
    .select("id")
    .eq("user_id", u.carol.userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (suspension) {
    // Carol submits an appeal.
    const { error: appealErr } = await u.carol.client
      .from("suspension_appeals")
      .insert({
        user_id: u.carol.userId,
        suspension_id: suspension.id,
        appeal_text: "This was a misunderstanding.",
      });
    assert(!appealErr, "Suspended user can submit an appeal");

    // Cannot submit a second pending appeal for the same suspension.
    const { error: dupErr } = await u.carol.client
      .from("suspension_appeals")
      .insert({
        user_id: u.carol.userId,
        suspension_id: suspension.id,
        appeal_text: "Trying again.",
      });
    assert(
      !!dupErr,
      "Second pending appeal for same suspension rejected (partial unique index)",
    );

    // Admin grants the appeal → is_suspended should clear.
    const { data: appeal } = await admin
      .from("suspension_appeals")
      .select("id")
      .eq("suspension_id", suspension.id)
      .single();

    if (appeal) {
      await admin
        .from("suspension_appeals")
        .update({
          status: "granted",
          resolved_by: u.alice.userId,
          resolved_at: new Date().toISOString(),
        })
        .eq("id", appeal.id);

      const { data: carolAfter } = await admin
        .from("users")
        .select("is_suspended, suspended_until")
        .eq("id", u.carol.userId)
        .single();
      assert(
        carolAfter?.is_suspended === false,
        "Granted appeal clears is_suspended",
      );
      assert(
        carolAfter?.suspended_until === null,
        "Granted appeal clears suspended_until",
      );
    }
  }
}

/**
 * Group 10 — Admin Access Control
 * PRD SEC-6, SEC-8, RLS policies on app_settings / audit_log /
 * warnings / suspensions / outbound_notifications.
 */
async function testAdminAccess(u: Record<string, UserHandle>) {
  section("10 · Admin Access Control");

  // Non-admin cannot write to app_settings.
  // RLS UPDATE with a blocking USING clause returns 0 rows affected, not an
  // error — so verify the value wasn't actually changed rather than expecting
  // an error object.
  await u.bob.client
    .from("app_settings")
    .update({ n_host_cap: 98 })
    .eq("id", 1);
  const { data: settingsCheck } = await admin
    .from("app_settings")
    .select("n_host_cap")
    .eq("id", 1)
    .single();
  assert(
    settingsCheck?.n_host_cap !== 98,
    "Non-admin cannot write to app_settings (value unchanged after attempt)",
  );

  // Admin CAN write to app_settings.
  const { error: adminSettingsErr } = await u.alice.client
    .from("app_settings")
    .update({ n_host_cap: 2 })
    .eq("id", 1);
  assert(!adminSettingsErr, "Admin can write to app_settings");

  // Non-admin cannot read audit_log.
  const { data: auditRead } = await u.bob.client.from("audit_log").select("id");
  assert(
    !auditRead || auditRead.length === 0,
    "Non-admin cannot read audit_log",
  );

  // Admin can read audit_log.
  const { error: adminAuditErr } = await u.alice.client
    .from("audit_log")
    .select("id");
  assert(!adminAuditErr, "Admin can read audit_log");

  // Non-admin cannot insert warnings.
  const { error: warnErr } = await u.bob.client.from("warnings").insert({
    user_id: u.bob.userId,
    reason: "self-granted warning",
  });
  assert(!!warnErr, "Non-admin cannot insert warnings");

  // Non-admin cannot insert suspensions.
  const { error: suspErr } = await u.bob.client.from("suspensions").insert({
    user_id: u.bob.userId,
    severity: "standard",
    reason: "self-suspension",
    ends_at: future(1),
  });
  assert(!!suspErr, "Non-admin cannot insert suspensions");

  // Non-admin cannot read outbound_notifications.
  const { data: notifRead } = await u.bob.client
    .from("outbound_notifications")
    .select("id");
  assert(
    !notifRead || notifRead.length === 0,
    "Non-admin cannot read outbound_notifications",
  );
}

/**
 * Group 11 — Chat Grace Period
 * PRD §3.6, CHAT-7, messages_insert_policy.
 *
 * The session must start in the future, so this test simulates an expired
 * grace window by temporarily setting chat_grace_period_days to a negative value.
 */
async function testChatGracePeriod(u: Record<string, UserHandle>) {
  section("11 · Chat Grace Period Boundary");

  const { data: originalSettings, error: settingsReadErr } = await admin
    .from("app_settings")
    .select("chat_grace_period_days, n_host_cap, n_total_cap")
    .eq("id", 1)
    .single();

  if (settingsReadErr || !originalSettings) {
    assert(
      false,
      "Could not read settings for chat grace-period test",
      settingsReadErr?.message ?? "No app_settings row found",
    );
    return;
  }

  try {
    // Earlier tests may have changed these limits. Raise them for session setup.
    const { error: limitsErr } = await admin
      .from("app_settings")
      .update({ n_host_cap: 99, n_total_cap: 99 })
      .eq("id", 1);

    if (limitsErr) {
      assert(false, "Could not raise limits for chat grace-period test", limitsErr.message);
      return;
    }

    const { data: testSession, error: sessionErr } = await makeSession(u.bob, {
      spots_total: 2,
      course_id: COURSE.CSC207,
      starts_at: future(2000),
      ends_at: future(2001),
    });

    if (sessionErr || !testSession) {
      assert(
        false,
        "Could not create session for chat grace-period test",
        sessionErr?.message ?? "Session insert returned no row",
      );
      return;
    }

    const { error: joinErr } = await u.carol.client.rpc("join_session", {
      p_session_id: testSession.id,
    });

    if (joinErr) {
      assert(false, "Could not join session for chat grace-period test", joinErr.message);
      return;
    }

    const { error: activeErr } = await u.carol.client.from("messages").insert({
      session_id: testSession.id,
      sender_id: u.carol.userId,
      content: "Message while grace period is open",
    });
    assert(
      !activeErr,
      "Member can send message while the grace window is open",
      activeErr?.message,
    );

    const { error: shortenGraceErr } = await admin
      .from("app_settings")
      .update({ chat_grace_period_days: -999 })
      .eq("id", 1);

    if (shortenGraceErr) {
      assert(
        false,
        "Could not simulate an expired chat grace period",
        shortenGraceErr.message,
      );
      return;
    }

    const { error: expiredErr } = await u.carol.client.from("messages").insert({
      session_id: testSession.id,
      sender_id: u.carol.userId,
      content: "Message after grace expiry",
    });
    assert(
      !!expiredErr,
      "Message blocked when grace period expired (messages_insert_policy)",
      expiredErr?.message,
    );

    // Message reads and membership checks should not depend on the grace window.
    const { error: readErr } = await u.carol.client
      .from("messages")
      .select()
      .eq("session_id", testSession.id);
    assert(
      !readErr,
      "Member can read history after the grace period expires",
      readErr?.message,
    );

    const { data: nonMemberRead, error: nonMemberReadErr } = await u.dana.client
      .from("messages")
      .select()
      .eq("session_id", testSession.id);
    assert(
      !nonMemberReadErr && (!nonMemberRead || nonMemberRead.length === 0),
      "Non-member cannot read messages",
      nonMemberReadErr?.message,
    );

    const { error: nonMemberWriteErr } = await u.dana.client
      .from("messages")
      .insert({
        session_id: testSession.id,
        sender_id: u.dana.userId,
        content: "Injected",
      });
    assert(
      !!nonMemberWriteErr,
      "Non-member cannot write messages",
      nonMemberWriteErr?.message,
    );
  } finally {
    const { error: restoreErr } = await admin
      .from("app_settings")
      .update({
        chat_grace_period_days: originalSettings.chat_grace_period_days,
        n_host_cap: originalSettings.n_host_cap,
        n_total_cap: originalSettings.n_total_cap,
      })
      .eq("id", 1)
      .select("id")
      .single();

    assert(
      !restoreErr,
      "Chat grace-period test settings restored",
      restoreErr?.message,
    );
  }
}

/**
 * Group 12 — Course Enrollment Limit
 * PRD COURSE-LIMIT, check_max_courses_limit trigger.
 */
async function testCourseLimits(u: Record<string, UserHandle>) {
  section("12 · Course Enrollment Limit (max 6)");

  // Alice is enrolled in 2 courses. Add 4 more to reach 6.
  const extraCourses = [
    COURSE.CSC258,
    COURSE.CSC263,
    COURSE.MAT102,
    COURSE.MAT232,
  ];
  for (const courseId of extraCourses) {
    await admin
      .from("user_courses")
      .insert({ user_id: u.alice.userId, course_id: courseId });
  }

  const { data: count } = await admin
    .from("user_courses")
    .select("course_id")
    .eq("user_id", u.alice.userId);
  assert(
    count?.length === 6,
    `Alice now has 6 enrolled courses (got ${count?.length})`,
  );

  // 7th course should be rejected.
  const { error: limitErr } = await admin.from("user_courses").insert({
    user_id: u.alice.userId,
    course_id: COURSE.STA256,
  });
  assert(!!limitErr, "7th course insertion rejected (check_max_courses_limit)");

  // Clean up extra enrollments.
  await admin
    .from("user_courses")
    .delete()
    .eq("user_id", u.alice.userId)
    .in("course_id", extraCourses);
}

// ─── Entry point ─────────────────────────────────────────────────────────────

async function main() {
  console.log("\n╔══════════════════════════════════════════╗");
  console.log("║   StudyMeet — Phase 2 Test Suite         ║");
  console.log("╚══════════════════════════════════════════╝");

  console.log("\n  Signing in as all test users...");
  let u: Record<string, UserHandle>;
  try {
    const [alice, bob, carol, dana, sam] = await Promise.all([
      signInAs("alice.admin@mail.utoronto.ca"),
      signInAs("bob.male@mail.utoronto.ca"),
      signInAs("carol.female@mail.utoronto.ca"),
      signInAs("dana.female2@mail.utoronto.ca"),
      signInAs("sam.prefernot@mail.utoronto.ca"),
    ]);
    u = { alice, bob, carol, dana, sam };
    console.log("  ✓ All users authenticated\n");
    // Raise caps to 99 so setup sessions across groups don't interfere.
    // testHostCap explicitly sets cap to 2 for its own isolated test.
    await admin
      .from("app_settings")
      .update({ n_host_cap: 99, n_total_cap: 99 })
      .eq("id", 1);
    console.log("  ✓ Caps raised to 99 for test isolation\n");
  } catch (e: any) {
    console.error(`\n  ✗ Could not sign in: ${e.message}`);
    console.error(
      "  → Run `npx supabase db reset && npm run seed:users` first.\n",
    );
    process.exit(1);
  }

  try {
    await testRLSVisibility(u);
    await testSessionCreation(u);
    await testHostCap(u);
    await testScheduleOverlap(u);
    await testJoinSession(u);
    await testConcurrentJoins(u);
    await testMemberDeparture(u);
    await testCancellationProtection(u);
    await testSuspension(u);
    await testAdminAccess(u);
    await testChatGracePeriod(u);
    await testCourseLimits(u);
  } finally {
    process.stdout.write("\n  Cleaning up test data...");
    await cleanup();
    console.log(" done");
  }

  const total = passed + failed;
  console.log("\n╔══════════════════════════════════════════╗");
  console.log(
    `║  ${passed}/${total} passed   ${failed > 0 ? `(${failed} FAILED)` : "✓ all green"}`.padEnd(
      43,
    ) + "║",
  );
  console.log("╚══════════════════════════════════════════╝");

  if (failures.length > 0) {
    console.log("\n  Failed tests:");
    failures.forEach((f) => console.log(`    ✗  ${f}`));
    console.log("");
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("\nUnexpected error:", err);
  process.exit(1);
});
