import { createClient } from "@/lib/supabase/server";

const MIN_SEARCH_LENGTH = 2;
const RESULTS_PER_SEARCH_FIELD = 10;

function escapeLikePattern(value: string) {
  return value.replace(/[\\%_]/g, "\\$&");
}

export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return Response.json({ error: "Authentication required." }, { status: 401 });
  }

  const query = new URL(request.url).searchParams.get("search")?.trim() ?? "";
  if (query.length < MIN_SEARCH_LENGTH) {
    return Response.json(
      { error: "Search must contain at least 2 characters." },
      { status: 400 },
    );
  }

  const pattern = `%${escapeLikePattern(query)}%`;
  const [codeResults, titleResults] = await Promise.all([
    supabase
      .from("courses")
      .select("id, course_code, course_title")
      .ilike("course_code", pattern)
      .order("course_code", { ascending: true })
      .limit(RESULTS_PER_SEARCH_FIELD),
    supabase
      .from("courses")
      .select("id, course_code, course_title")
      .ilike("course_title", pattern)
      .order("course_code", { ascending: true })
      .limit(RESULTS_PER_SEARCH_FIELD),
  ]);

  const queryError = codeResults.error ?? titleResults.error;
  if (queryError) {
    return Response.json(
      { error: "Could not search courses. Please try again." },
      { status: 500 },
    );
  }

  // Merge both bounded result sets and remove courses that match both fields.
  const uniqueCourses = new Map(
    [...(codeResults.data ?? []), ...(titleResults.data ?? [])].map((course) => [
      course.id,
      course,
    ]),
  );

  return Response.json({ courses: [...uniqueCourses.values()] });
}
