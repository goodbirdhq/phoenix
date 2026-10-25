import { createFormHook, createFormHookContexts } from "@tanstack/react-form";
import { useId, type ComponentProps, type ReactNode } from "react";
import { Field, FieldError, FieldLabel } from "~/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput } from "~/components/ui/input-group";

export const { fieldContext, formContext, useFieldContext } = createFormHookContexts();

function TextField({
  label,
  icon,
  ...props
}: ComponentProps<"input"> & { label: string; icon?: ReactNode }) {
  const field = useFieldContext<string>();
  const id = useId();
  const invalid = field.state.meta.isTouched && !field.state.meta.isValid;
  return (
    <Field data-invalid={invalid}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <InputGroup>
        <InputGroupInput
          {...props}
          id={id}
          name={field.name}
          value={field.state.value}
          onChange={(event) => field.handleChange(event.target.value)}
          onBlur={field.handleBlur}
          aria-invalid={invalid}
          aria-describedby={invalid ? `${id}-error` : undefined}
        />
        {icon && <InputGroupAddon>{icon}</InputGroupAddon>}
      </InputGroup>
      {invalid && <FieldError id={`${id}-error`} errors={field.state.meta.errors} />}
    </Field>
  );
}

export const { useAppForm } = createFormHook({
  fieldContext,
  formContext,
  fieldComponents: { TextField },
  formComponents: {},
});
