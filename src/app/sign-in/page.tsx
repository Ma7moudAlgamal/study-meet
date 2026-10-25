import SignInForm from "./sign-in-form"

const authErrorMessages = new Map([
    ["missing_code", "This sign-in link is incomplete. Please request a new link."],
    [
        "authentication_failed",
        "This sign-in link could not be verified. Request a new link and open it in the same browser where you requested it.",
    ],
    ["user_not_found", "We could not verify your sign-in. Please request a new link."],
    [
        "profile_fetch_failed",
        "Your sign-in succeeded, but we could not load your profile. Please try again.",
    ],
]);

export default async function SignIn({
    searchParams,
}: {
    searchParams: Promise<{ error?: string | string[] }>;
}) {
    const { error } = await searchParams;
    const errorKey = typeof error === "string" ? error : undefined;
    const errorMessage = errorKey ? authErrorMessages.get(errorKey) : undefined;

    return (
        <div>
            <h1>Sign In to study meet</h1>
            {errorMessage && <p role="alert">{errorMessage}</p>}
            <SignInForm />
        </div>
    )
}