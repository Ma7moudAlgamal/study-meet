"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Input } from "@/components/ui/input";
import CoursePicker from "./course-picker";
import { supabase } from "@/lib/supabase";

export default function OnboardingForm() {
  const genders = [
    { value: "Male", label: "Male" },
    { value: "Female", label: "Female" },
    { value: "Prefer not to say", label: "Prefer Not to Say" },
  ];

  const [coursesmessage, setCoursesMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function handleSubmit(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);

    const formData = new FormData(event.currentTarget);
    const data = Object.fromEntries(formData.entries());
    const firstName = data.first_name as string;
    const lastName = data.last_name as string;
    const gender = data.gender as string;
    const ids = formData.getAll("course_ids") as string[];

    if (ids.length === 0) {
      setCoursesMessage("Please select at least one course.");
      setLoading(false);
      return;
    }

    const supabase = createClient();
    const { error } = await supabase.rpc("complete_onboarding", {
      p_first_name: firstName,
      p_last_name: lastName,
      p_gender: gender,
      p_course_ids: ids,
    });

    if (error) {
      console.error("Error completing onboarding:", error);
      setCoursesMessage("Failed to complete onboarding. Please try again.");
      setLoading(false);
      return;
    }
    setLoading(false);
    router.replace("/feed");
  }

  return (
    <form onSubmit={handleSubmit}>
      <FieldGroup>
        <div className="grid grid-cols-2 gap-4">
          <Field>
            <FieldLabel htmlFor="first_name">
              First Name<span className="text-destructive">*</span>{" "}
            </FieldLabel>
            <Input
              required
              id="first_name"
              name="first_name"
              placeholder="Hani"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="last_name">
              Last Name<span className="text-destructive">*</span>
            </FieldLabel>
            <Input
              required
              id="last_name"
              name="last_name"
              placeholder="Alhaj"
            />
          </Field>
        </div>
        <Field>
          <FieldLabel htmlFor="gender">
            Gender<span className="text-destructive">*</span>
          </FieldLabel>
          <Select required id="gender" name="gender" items={genders}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {genders.map((gender) => (
                  <SelectItem key={gender.value} value={gender.value}>
                    {gender.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        <CoursePicker />
        {coursesmessage && (
          <p className="text-destructive text-sm mt-1">{coursesmessage}</p>
        )}
        <Field>
          {loading ? (
            <Button variant="secondary" className="w-full" disabled>
              Loading
              <Spinner data-icon="inline-start" />
            </Button>
          ) : (
            <Button type="submit" className="w-full">
              Submit
            </Button>
          )}
        </Field>
      </FieldGroup>
    </form>
  );
}
