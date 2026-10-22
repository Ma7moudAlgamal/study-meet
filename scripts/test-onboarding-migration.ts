import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config({ path: ".env.production" });

const { supabaseUrl, anonKey, serviceRoleKey } = (() => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publicKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const secretKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !publicKey || !secretKey) {
    throw new Error(
      "Set NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY.",
    );
  }

  return { supabaseUrl: url, anonKey: publicKey, serviceRoleKey: secretKey };
})();

const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const anonymous = createClient(supabaseUrl, anonKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
  console.log(`✓ ${message}`);
}

async function main() {
  const unique = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const validEmail = `onboarding-test-${unique}@mail.utoronto.ca`;
  const invalidEmail = `onboarding-test-${unique}@fakeutoronto.ca`;
  const password = `Test-${crypto.randomUUID()}-aA1!`;
  let validUserId: string | undefined;
  let invalidUserId: string | undefined;

  try {
    const unauthenticatedRpc = await anonymous.rpc("complete_onboarding", {
      p_first_name: "Test",
      p_last_name: "User",
      p_gender: "Prefer not to say",
      p_course_ids: [],
    });
    assert(
      !!unauthenticatedRpc.error,
      "Anonymous users cannot call the onboarding function",
    );

    const invalidSignup = await admin.auth.admin.createUser({
      email: invalidEmail,
      password,
      email_confirm: true,
    });
    invalidUserId = invalidSignup.data.user?.id;
    assert(
      !!invalidSignup.error,
      "Auth rejects a non-UTM email through the database trigger",
    );
    if (invalidUserId) {
      throw new Error("Invalid-domain signup unexpectedly created an auth user.");
    }

    const signup = await admin.auth.admin.createUser({
      email: validEmail,
      password,
      email_confirm: true,
    });
    if (signup.error || !signup.data.user) {
      throw new Error(`Valid test signup failed: ${signup.error?.message}`);
    }
    const createdUserId = signup.data.user.id;
    validUserId = createdUserId;
    assert(true, "A valid UTM email can authenticate without profile metadata");

    const initialProfile = await admin
      .from("users")
      .select("id")
      .eq("id", createdUserId)
      .maybeSingle();
    if (initialProfile.error) throw initialProfile.error;
    assert(!initialProfile.data, "Auth signup does not create an incomplete profile");

    const course = await admin
      .from("courses")
      .select("id")
      .limit(1)
      .single();
    if (course.error) {
      throw new Error(`Could not load a course for testing: ${course.error.message}`);
    }

    const signedIn = await createClient(supabaseUrl, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    }).auth.signInWithPassword({ email: validEmail, password });
    if (signedIn.error || !signedIn.data.session) {
      throw new Error(`Test user sign-in failed: ${signedIn.error?.message}`);
    }

    const userClient = createClient(supabaseUrl, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: {
        headers: {
          Authorization: `Bearer ${signedIn.data.session.access_token}`,
        },
      },
    });

    const invalidOnboarding = await userClient.rpc("complete_onboarding", {
      p_first_name: "Test",
      p_last_name: "User",
      p_gender: "Prefer not to say",
      p_course_ids: [],
    });
    assert(!!invalidOnboarding.error, "Onboarding rejects an empty course selection");

    const profileAfterFailure = await admin
      .from("users")
      .select("id")
      .eq("id", createdUserId)
      .maybeSingle();
    if (profileAfterFailure.error) throw profileAfterFailure.error;
    assert(
      !profileAfterFailure.data,
      "Failed onboarding leaves no partial profile behind",
    );

    const completion = await userClient.rpc("complete_onboarding", {
      p_first_name: "  Test  ",
      p_last_name: "  Student  ",
      p_gender: "Prefer not to say",
      p_course_ids: [course.data.id],
    });
    if (completion.error) {
      throw new Error(`Valid onboarding failed: ${completion.error.message}`);
    }
    assert(true, "A signed-in user can complete onboarding");

    const completedProfile = await admin
      .from("users")
      .select("email, first_name, last_name, gender")
      .eq("id", createdUserId)
      .single();
    if (completedProfile.error) throw completedProfile.error;
    assert(
      completedProfile.data.email === validEmail
        && completedProfile.data.first_name === "Test"
        && completedProfile.data.last_name === "Student"
        && completedProfile.data.gender === "Prefer not to say",
      "Onboarding creates the profile with trimmed names and the authenticated email",
    );

    const enrollment = await admin
      .from("user_courses")
      .select("course_id")
      .eq("user_id", createdUserId)
      .eq("course_id", course.data.id)
      .single();
    if (enrollment.error) throw enrollment.error;
    assert(true, "Onboarding creates the selected course enrollment");

    const duplicateCompletion = await userClient.rpc("complete_onboarding", {
      p_first_name: "Another",
      p_last_name: "Attempt",
      p_gender: "Prefer not to say",
      p_course_ids: [course.data.id],
    });
    assert(
      !!duplicateCompletion.error,
      "A completed profile cannot be overwritten by repeating onboarding",
    );
  } finally {
    if (invalidUserId) {
      const { error } = await admin.auth.admin.deleteUser(invalidUserId);
      if (error) throw new Error(`Failed to clean up invalid test user: ${error.message}`);
    }
    if (validUserId) {
      const { error } = await admin.auth.admin.deleteUser(validUserId);
      if (error) throw new Error(`Failed to clean up test user: ${error.message}`);
    }
  }
}

main().catch((error: unknown) => {
  console.error("Onboarding migration test failed:", error);
  process.exitCode = 1;
});
