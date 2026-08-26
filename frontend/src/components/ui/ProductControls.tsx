import * as React from "react";
import { cn } from "@/lib/utils";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md" | "icon";

const buttonVariants: Record<ButtonVariant, string> = {
  primary: "bg-primary text-primary-foreground shadow-sm hover:bg-primary/90",
  secondary: "border border-border/90 bg-card text-foreground hover:bg-accent/65",
  ghost: "text-muted-foreground hover:bg-accent/65 hover:text-accent-foreground",
  danger: "bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90",
};

const buttonSizes: Record<ButtonSize, string> = {
  sm: "h-8 gap-1.5 rounded-lg px-3 text-[12px]",
  md: "h-9 gap-2 rounded-lg px-4 text-[13px]",
  icon: "h-8 w-8 rounded-lg",
};

export const ProductButton = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: ButtonVariant;
    size?: ButtonSize;
  }
>(({ className, variant = "secondary", size = "md", type = "button", ...props }, ref) => (
  <button
    ref={ref}
    type={type}
    className={cn(
      "inline-flex shrink-0 items-center justify-center font-medium transition duration-150",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/35",
      "active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40",
      buttonVariants[variant],
      buttonSizes[size],
      className,
    )}
    {...props}
  />
));
ProductButton.displayName = "ProductButton";

export const ProductInput = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={cn(
      "h-9 rounded-lg border border-input bg-card px-3 text-[13px] text-foreground shadow-[0_1px_2px_hsl(var(--foreground)/0.03)]",
      "outline-none transition placeholder:text-muted-foreground/75",
      "focus:border-primary/70 focus:ring-2 focus:ring-primary/15",
      "disabled:cursor-not-allowed disabled:bg-muted/45 disabled:opacity-60",
      className,
    )}
    {...props}
  />
));
ProductInput.displayName = "ProductInput";

export const ProductSelect = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(({ className, ...props }, ref) => (
  <select
    ref={ref}
    className={cn(
      "h-9 rounded-lg border border-input bg-card px-3 text-[13px] text-foreground shadow-[0_1px_2px_hsl(var(--foreground)/0.03)]",
      "outline-none transition focus:border-primary/70 focus:ring-2 focus:ring-primary/15",
      "disabled:cursor-not-allowed disabled:bg-muted/45 disabled:opacity-60",
      className,
    )}
    {...props}
  />
));
ProductSelect.displayName = "ProductSelect";

export function ProductSegmentedControl<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  className,
}: {
  value: T;
  onChange: (value: T) => void;
  options: Array<{ value: T; label: React.ReactNode; icon?: React.ReactNode }>;
  ariaLabel: string;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn("inline-flex h-9 items-center rounded-lg bg-muted p-0.5", className)}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(option.value)}
            className={cn(
              "flex h-8 min-w-[96px] items-center justify-center gap-1.5 rounded-[7px] px-3 text-[12px] transition duration-150",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 active:scale-[0.98]",
              active
                ? "bg-card font-medium text-foreground shadow-[0_1px_3px_hsl(var(--foreground)/0.08)]"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option.icon}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export function ProductIconButton({
  active,
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <ProductButton
      size="icon"
      variant="ghost"
      className={cn(active && "bg-card text-foreground shadow-sm hover:bg-card", className)}
      {...props}
    />
  );
}

export function ProductEmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex min-h-[320px] flex-col items-center justify-center px-6 py-12 text-center", className)}>
      <div className="grid h-11 w-11 place-items-center rounded-[13px] border border-border/80 bg-accent/65 text-primary shadow-[0_10px_28px_hsl(var(--primary)/0.08)]">
        {icon}
      </div>
      <h3 className="mt-4 text-[14px] font-semibold tracking-[-0.01em] text-foreground">{title}</h3>
      {description && (
        <p className="mt-1.5 max-w-[420px] text-[12px] leading-5 text-muted-foreground">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ProductPanel({
  children,
  className,
}: React.HTMLAttributes<HTMLElement>) {
  return <section className={cn("calmee-panel overflow-hidden", className)}>{children}</section>;
}
