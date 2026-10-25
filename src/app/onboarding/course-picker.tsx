"use client";

import { useEffect, useState } from "react";
import {
  Field,
  FieldDescription,
  FieldLabel,
} from "@/components/ui/field";
import {
  MultiSelect,
  MultiSelectContent,
  MultiSelectItem,
  MultiSelectTrigger,
  MultiSelectValue,
} from "@/components/ui/multi-select";

type Course = {
  id: string;
  course_code: string;
  course_title: string;
};

const MIN_SEARCH_LENGTH = 2;
const MAX_SELECTED_COURSES = 6;
export default function CoursePicker() {
  const [searchText, setSearchText] = useState("");
  const [courses, setCourses] = useState<Course[]>([]);
  const [selectedCourses, setSelectedCourses] = useState<Course[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [selectionMessage, setSelectionMessage] = useState("");

  useEffect(() => {
    const query = searchText.trim();

    if (query.length < MIN_SEARCH_LENGTH) {
      return;
    }

    const controller = new AbortController();
    // Debouncing avoids querying the catalog for every keystroke.
    const timeoutId = setTimeout(async () => {
      try {
        const response = await fetch(
          `/api/courses?search=${encodeURIComponent(query)}`,
          { signal: controller.signal },
        );

        if (controller.signal.aborted) return;

        if (!response.ok) {
          if (response.status === 401) {
            setCourses([]);
            setErrorMessage("Your session expired. Please sign in again.");
            setIsLoading(false);
            return;
          }

          setCourses([]);
          setErrorMessage("Could not search courses. Please try again.");
          setIsLoading(false);
          return;
        }

        const result = (await response.json()) as { courses: Course[] };
        setCourses(result.courses);
        setIsLoading(false);
      } catch {
        if (controller.signal.aborted) return;
        setCourses([]);
        setErrorMessage("Could not search courses. Please try again.");
        setIsLoading(false);
      }
    }, 300);

    return () => {
      clearTimeout(timeoutId);
      controller.abort();
    };
  }, [searchText]);

  function handleSearchValueChange(value: string) {
    const query = value.trim();
    setSearchText(value);
    setIsLoading(query.length >= MIN_SEARCH_LENGTH);

    if (query.length < MIN_SEARCH_LENGTH) {
      setCourses([]);
      setErrorMessage("");
    } else {
      setErrorMessage("");
    }
  }

  function handleSelectedValuesChange(nextIds: string[]) {
    if (nextIds.length > MAX_SELECTED_COURSES) {
      setSelectionMessage("You can select up to 6 courses.");
      return;
    }

    setSelectionMessage("");
    setSelectedCourses((currentCourses) => {
      const retainedCourses = currentCourses.filter((course) =>
        nextIds.includes(course.id),
      );
      const retainedIds = new Set(retainedCourses.map((course) => course.id));
      const newlySelectedCourses = courses.filter(
        (course) => nextIds.includes(course.id) && !retainedIds.has(course.id),
      );

      return [...retainedCourses, ...newlySelectedCourses];
    });
  }

  const emptyMessage =
    searchText.trim().length < MIN_SEARCH_LENGTH
      ? "Type at least 2 characters to search."
      : isLoading
        ? "Searching courses..."
        : "No matching courses found.";
  const visibleCourses =
    searchText.trim().length >= MIN_SEARCH_LENGTH ? courses : [];

  return (
    <Field>
      <FieldLabel htmlFor="course-picker">
        Enrolled courses<span className="text-destructive">*</span>
      </FieldLabel>
      <MultiSelect
        values={selectedCourses.map((course) => course.id)}
        onValuesChange={handleSelectedValuesChange}
      >
        <MultiSelectTrigger id="course-picker" className="w-full">
          <MultiSelectValue
            placeholder="Search and select up to 6 courses"
            overflowBehavior="wrap"
          />
        </MultiSelectTrigger>
        <MultiSelectContent
          search={{
            placeholder: "Search by course code or title...",
            emptyMessage,
          }}
          onSearchValueChange={handleSearchValueChange}
          shouldFilter={false}
        >
          {visibleCourses.map((course) => (
            <MultiSelectItem
              key={course.id}
              value={course.id}
              badgeLabel={course.course_code}
            >
              <span>
                <span className="font-medium">{course.course_code}</span>
                {" — "}
                {course.course_title}
              </span>
            </MultiSelectItem>
          ))}
        </MultiSelectContent>
      </MultiSelect>

      {selectedCourses.map((course) => (
        <input
          key={course.id}
          type="hidden"
          name="course_ids"
          value={course.id}
        />
      ))}

      <FieldDescription>
        {selectedCourses.length} of {MAX_SELECTED_COURSES} courses selected.
      </FieldDescription>
      {isLoading && (
        <p role="status" className="text-sm text-muted-foreground">
          Searching courses...
        </p>
      )}
      {errorMessage && (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage}
        </p>
      )}
      {selectionMessage && (
        <p role="alert" className="text-sm text-destructive">
          {selectionMessage}
        </p>
      )}
    </Field>
  );
}
