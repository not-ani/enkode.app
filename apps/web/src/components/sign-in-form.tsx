import { Button } from "@enkode.app/ui/components/button";
import { Input } from "@enkode.app/ui/components/input";
import { Label } from "@enkode.app/ui/components/label";
import { useForm } from "@tanstack/react-form";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import z from "zod";

import { authClient } from "@/lib/auth-client";
import { studentCredentialEmail } from "@enkode.app/backend/convex/studentCredentials";

export default function SignInForm() {
  const navigate = useNavigate({
    from: "/",
  });

  const form = useForm({
    defaultValues: {
      identifier: "",
      organization: "",
      password: "",
    },
    onSubmit: async ({ value }) => {
      const email = value.organization
        ? studentCredentialEmail(value.organization.trim().toLowerCase(), value.identifier)
        : value.identifier.trim().toLowerCase();
      await authClient.signIn.email(
        {
          email,
          password: value.password,
        },
        {
          onSuccess: () => {
            navigate({
              to: "/dashboard",
            });
            toast.success("Sign in successful");
          },
          onError: (error) => {
            toast.error(error.error.message || error.error.statusText);
          },
        },
      );
    },
    validators: {
      onSubmit: z
        .object({
          identifier: z.string().trim().min(1, "Email or username is required"),
          organization: z.string().trim(),
          password: z.string().min(8, "Password must be at least 8 characters"),
        })
        .refine(
          ({ identifier, organization }) => organization || z.email().safeParse(identifier).success,
          { message: "Enter a valid email or add your organization", path: ["identifier"] },
        )
        .refine(
          ({ identifier, organization }) =>
            !organization || /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(identifier),
          { message: "Enter your organization username", path: ["identifier"] },
        )
        .refine(
          ({ organization }) => !organization || /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(organization),
          { message: "Enter the organization name from your teacher", path: ["organization"] },
        ),
    },
  });

  return (
    <div className="mx-auto w-full mt-10 max-w-md p-6">
      <h1 className="mb-2 text-center text-3xl font-bold">Welcome back</h1>
      <p className="text-muted-foreground mb-6 text-center text-sm">
        Teachers use email. Students add their organization and username.
      </p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          e.stopPropagation();
          form.handleSubmit();
        }}
        className="space-y-4"
      >
        <div>
          <form.Field name="organization">
            {(field) => (
              <div className="space-y-2">
                <Label htmlFor={field.name}>Organization</Label>
                <Input
                  id={field.name}
                  name={field.name}
                  placeholder="Students: example-academy"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
                {field.state.meta.errors.map((error) => (
                  <p key={error?.message} className="text-red-500">
                    {error?.message}
                  </p>
                ))}
              </div>
            )}
          </form.Field>
        </div>

        <div>
          <form.Field name="identifier">
            {(field) => (
              <div className="space-y-2">
                <Label htmlFor={field.name}>
                  {form.state.values.organization ? "Username" : "Email"}
                </Label>
                <Input
                  id={field.name}
                  name={field.name}
                  autoComplete="username"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
                {field.state.meta.errors.map((error) => (
                  <p key={error?.message} className="text-red-500">
                    {error?.message}
                  </p>
                ))}
              </div>
            )}
          </form.Field>
        </div>

        <div>
          <form.Field name="password">
            {(field) => (
              <div className="space-y-2">
                <Label htmlFor={field.name}>Password</Label>
                <Input
                  id={field.name}
                  name={field.name}
                  type="password"
                  autoComplete="current-password"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
                {field.state.meta.errors.map((error) => (
                  <p key={error?.message} className="text-red-500">
                    {error?.message}
                  </p>
                ))}
              </div>
            )}
          </form.Field>
        </div>

        <form.Subscribe
          selector={(state) => ({ canSubmit: state.canSubmit, isSubmitting: state.isSubmitting })}
        >
          {({ canSubmit, isSubmitting }) => (
            <Button type="submit" className="w-full" disabled={!canSubmit || isSubmitting}>
              {isSubmitting ? "Submitting..." : "Sign In"}
            </Button>
          )}
        </form.Subscribe>
      </form>

      <p className="text-muted-foreground mt-4 text-center text-sm">
        Need access? Ask your organization or teacher to provision your account.
      </p>
    </div>
  );
}
