"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";

export default function SignInForm() {
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const email = (formData.get("email") as string).trim().toLowerCase();

    if (!email.endsWith("@mail.utoronto.ca")) {
      setMessage("Please use your UofT email address.");
      return;

    } 

    setLoading(true);
    setMessage("");

    const supabase = createClient();
    
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      },
    });
    setLoading(false);
    if (error) {
      setMessage(`Error: ${error.message}`);
      return;
    }
    setMessage("Check your email for the login link!");
  }

  return (
    <form onSubmit={handleSubmit}>
      <label htmlFor="email">Email</label>
      <input required type="email" name="email" id="email" />
      <Button type="submit" disabled={loading}>
        {loading ? "Submitting..." : "Submit"}
      </Button>
        {message && <p role="status">{message}</p>}
    </form>
  );
}
