import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get("code");

  if (!code) {
    return NextResponse.redirect(
      new URL("/sign-in?error=missing_code", request.url),
    );
  }

  // Create the Supabase server client
  const supabase = await createClient();

  // Exchange code for a real user session
  const {error } = await supabase.auth.exchangeCodeForSession(code);

  // Handle failure to exchange code for session
  if (error) {
    return NextResponse.redirect(
      new URL("/sign-in?error=authentication_failed", request.url),
    );
  }

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return NextResponse.redirect(
      new URL("/sign-in?error=user_not_found", request.url),
    );
  }

  const { data: profile, error: profileError } = await supabase
    .from("users")
    .select("id")
    .eq("id", user.id)
    .maybeSingle();

    if (profileError) {
    return NextResponse.redirect(
      new URL("/sign-in?error=profile_fetch_failed", request.url),
    );
  }


  return NextResponse.redirect(new URL(!profile ?"/onboarding" : "/feed", request.url));
}
