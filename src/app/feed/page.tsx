import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

export default async function Feed() {
  const supabase = await createClient();

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    redirect("/sign-in");
  }

  const { data: profile, error: profileError } = await supabase
    .from("users")
    .select("id")
    .eq("id", user.id)
    .maybeSingle();

  if (profileError) {
    throw new Error("Failed to fetch profile data");
  }

  if (!profile) {
    redirect("/onboarding");
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-screen py-2">
      <h1 className="text-2xl font-bold">Feed</h1>
    </div>
  );
}
