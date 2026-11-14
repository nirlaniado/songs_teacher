import { createElement, type ComponentProps } from "react";

/**
 * The app's two controls. Every visual decision lives in `index.css` under the class names produced here, so the next
 * design pass edits one file. Never mount a `SlideRenderer` inside a Button: its press transform and type styles would
 * reach slide content, which is why the thumbnail rail uses `.slide-thumb` instead.
 */

export type ButtonVariant = "primary" | "secondary" | "subtle" | "destructive" | "destructive-subtle";
export type ControlSize = "sm" | "md" | "lg";

const join = (...parts: Array<string | false | undefined>) => parts.filter(Boolean).join(" ");

export interface ButtonLook {
  variant?: ButtonVariant;
  size?: ControlSize;
  /** A square, glyph-only button; "round" is reserved for transport keys. */
  icon?: boolean | "round";
}

/** For a non-`button` element that must look like one, such as the `label` wrapping a file input. */
export const buttonClass = ({ variant = "secondary", size = "md", icon }: ButtonLook = {}, className?: string) =>
  join(
    "control",
    `control-${variant}`,
    `control-${size}`,
    icon && "control-icon",
    icon === "round" && "control-round",
    className,
  );

export function Button({
  variant,
  size,
  icon,
  pressed,
  tone,
  type = "button",
  className,
  ...rest
}: ButtonLook &
  ComponentProps<"button"> & {
    /** Makes it a toggle: announced as pressed, and lit while on. */
    pressed?: boolean;
    /** The lit colour of a toggle whose on-state means something, like Mute and Solo. */
    tone?: "danger" | "warning";
  }) {
  return (
    <button
      type={type}
      aria-pressed={pressed}
      data-tone={tone}
      className={buttonClass({ variant, size, icon }, className)}
      {...rest}
    />
  );
}

export const fieldClass = (size: ControlSize = "md", className?: string) => join("field", `field-${size}`, className);

type FieldProps = { size?: ControlSize; invalid?: boolean } & (
  | ({ as?: "input" } & Omit<ComponentProps<"input">, "size">)
  | ({ as: "select" } & Omit<ComponentProps<"select">, "size">)
  | ({ as: "textarea" } & ComponentProps<"textarea">)
);

export function Field({ as = "input", size, invalid, className, ...rest }: FieldProps) {
  return createElement(as, {
    ...rest,
    "aria-invalid": invalid || undefined,
    className: fieldClass(size, className),
  });
}
