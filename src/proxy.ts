import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  function redirectWithCookies(destination: URL) {
    const redirectResponse = NextResponse.redirect(destination);
    response.cookies.getAll().forEach((cookie) => {
      redirectResponse.cookies.set(cookie);
    });
    return redirectResponse;
  }

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => {
            request.cookies.set(name, value);
          });

          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set(name, value, options);
          });
        },
      },
    },
  );

  // This refreshes the session and validates it with Supabase Auth.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const pathname = request.nextUrl.pathname;
  const isSignInRoute = pathname === "/sign-in";
  const isProtectedPage =
    pathname === "/onboarding" ||
    pathname === "/feed" ||
    pathname.startsWith("/feed/");

  if (isProtectedPage && !user) {
    const signInUrl = new URL("/sign-in", request.url);
    return redirectWithCookies(signInUrl);
  }

  if (isSignInRoute && user) {
    const destination = new URL("/onboarding", request.url);
    return redirectWithCookies(destination);
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * Run for app pages, excluding static assets and Next.js internals.
     * API routes keep their own authentication and authorization checks.
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
