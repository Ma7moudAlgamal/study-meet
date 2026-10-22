CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.email IS NULL
       OR NEW.email !~* '^[A-Za-z0-9._%+-]+@mail\.utoronto\.ca$' THEN
        RAISE EXCEPTION 'Access restricted to @mail.utoronto.ca email addresses only.';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.complete_onboarding(
    p_first_name TEXT,
    p_last_name TEXT,
    p_gender public.user_gender,
    p_course_ids UUID[]
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_email TEXT;
    v_course_count BIGINT;
BEGIN
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Authentication is required to complete onboarding.';
    END IF;

    IF NULLIF(BTRIM(p_first_name), '') IS NULL
       OR NULLIF(BTRIM(p_last_name), '') IS NULL THEN
        RAISE EXCEPTION 'First name and last name are required.';
    END IF;

    IF p_gender IS NULL THEN
        RAISE EXCEPTION 'Gender is required.';
    END IF;

    IF p_course_ids IS NULL
       OR CARDINALITY(p_course_ids) < 1
       OR CARDINALITY(p_course_ids) > 6
       OR array_position(p_course_ids, NULL) IS NOT NULL THEN
        RAISE EXCEPTION 'Select between 1 and 6 valid courses.';
    END IF;

    IF (
        SELECT COUNT(DISTINCT course_id)
        FROM unnest(p_course_ids) AS selected(course_id)
    ) <> CARDINALITY(p_course_ids) THEN
        RAISE EXCEPTION 'A course may only be selected once.';
    END IF;

    SELECT email
    INTO v_email
    FROM auth.users
    WHERE id = v_user_id;

    IF v_email IS NULL
       OR v_email !~* '^[A-Za-z0-9._%+-]+@mail\.utoronto\.ca$' THEN
        RAISE EXCEPTION 'Access restricted to @mail.utoronto.ca email addresses only.';
    END IF;

    SELECT COUNT(*)
    INTO v_course_count
    FROM public.courses
    WHERE id = ANY(p_course_ids);

    IF v_course_count <> CARDINALITY(p_course_ids) THEN
        RAISE EXCEPTION 'One or more selected courses do not exist.';
    END IF;

    IF EXISTS (SELECT 1 FROM public.users WHERE id = v_user_id) THEN
        RAISE EXCEPTION 'Onboarding has already been completed.';
    END IF;

    INSERT INTO public.users (id, email, first_name, last_name, gender)
    VALUES (
        v_user_id,
        v_email,
        BTRIM(p_first_name),
        BTRIM(p_last_name),
        p_gender
    );

    INSERT INTO public.user_courses (user_id, course_id)
    SELECT v_user_id, course_id
    FROM unnest(p_course_ids) AS selected(course_id);
END;
$$;

REVOKE ALL ON FUNCTION public.complete_onboarding(TEXT, TEXT, public.user_gender, UUID[])
    FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_onboarding(TEXT, TEXT, public.user_gender, UUID[])
    TO authenticated;