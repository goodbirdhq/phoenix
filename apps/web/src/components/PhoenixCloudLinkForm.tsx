import { createFormHook, createFormHookContexts, useStore } from "@tanstack/react-form";
import { useId } from "react";
import type { EnvironmentId } from "@t3tools/contracts";

import { usePhoenixCloudSignIn } from "../hooks/usePhoenixCloudAccount";
import { ensureLocalApi } from "../localApi";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Field, FieldLabel, FieldError } from "./ui/field";

const { fieldContext, formContext, useFieldContext } = createFormHookContexts();

function LinkTextField({
  label,
  disabled,
  maxLength,
  placeholder,
}: {
  label: string;
  disabled: boolean;
  maxLength?: number;
  placeholder?: string;
}) {
  const id = useId();
  const errorId = `${id}-error`;
  const field = useFieldContext<string>();
  const errors = useStore(field.store, (state) => state.meta.errors);
  return (
    <Field data-invalid={errors.length > 0} data-disabled={disabled}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        name={field.name}
        aria-describedby={errors.length > 0 ? errorId : undefined}
        aria-invalid={errors.length > 0}
        value={field.state.value}
        onChange={(event) => field.handleChange(event.target.value)}
        onBlur={field.handleBlur}
        disabled={disabled}
        maxLength={maxLength}
        placeholder={placeholder}
      />
      {errors.length > 0 ? (
        <FieldError id={errorId} errors={errors.map((error) => ({ message: String(error) }))} />
      ) : null}
    </Field>
  );
}

const { useAppForm } = createFormHook({
  fieldContext,
  formContext,
  fieldComponents: { LinkTextField },
  formComponents: {},
});

export function PhoenixCloudLinkForm({
  environmentId,
  environmentLabel,
}: {
  environmentId: EnvironmentId;
  environmentLabel: string;
}) {
  const flow = usePhoenixCloudSignIn(environmentId);
  const form = useAppForm({
    defaultValues: { name: environmentLabel.slice(0, 80), cloudUrl: "" },
    onSubmit: async ({ value }) => flow.login(value),
  });
  if (!flow.allowed)
    return (
      <p className="text-sm text-muted-foreground">
        The installation owner needs to link this environment to Phoenix Cloud. Managing ownership
        requires access administration permission.
      </p>
    );
  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <form.AppField
        name="name"
        validators={{
          onChange: ({ value }) => (value.trim() ? undefined : "Enter an installation name."),
        }}
      >
        {(field) => (
          <field.LinkTextField label="Installation name" maxLength={80} disabled={flow.pending} />
        )}
      </form.AppField>
      <form.AppField name="cloudUrl">
        {(field) => (
          <field.LinkTextField
            label="Cloud URL (optional)"
            placeholder="Use the server configuration"
            disabled={flow.pending}
          />
        )}
      </form.AppField>
      <p className="text-sm text-muted-foreground">
        Approve this installation on the Phoenix Cloud website to use Phoenix.
      </p>
      {flow.error ? (
        <p role="alert" className="text-sm text-destructive-foreground">
          {flow.error}
        </p>
      ) : null}
      {flow.attempt ? (
        <div className="flex flex-col gap-3" role="status">
          <p className="text-sm">
            Confirm code{" "}
            <strong className="font-mono tracking-widest">{flow.attempt.userCode}</strong> on the
            website.
          </p>
          <p className="text-xs text-muted-foreground">
            Waiting for approval. Expires {new Date(flow.attempt.expiresAt).toLocaleTimeString()}.
          </p>
          <div className="flex gap-2">
            <Button
              type="button"
              onClick={() =>
                void ensureLocalApi()
                  .shell.openExternal(
                    flow.attempt!.verificationUriComplete ?? flow.attempt!.verificationUri,
                  )
                  .catch(() => undefined)
              }
            >
              Open website
            </Button>
            <Button type="button" variant="outline" onClick={() => void flow.cancelSignIn()}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <form.Subscribe selector={(state) => state.canSubmit}>
          {(canSubmit) => (
            <Button type="submit" disabled={!canSubmit || flow.pending || flow.status.isPending}>
              {flow.pending ? "Starting…" : "Link Phoenix Cloud account"}
            </Button>
          )}
        </form.Subscribe>
      )}
    </form>
  );
}
