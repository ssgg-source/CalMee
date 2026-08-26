import * as React from "react";
import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";

export function ProductPage({ children, className }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("calmee-page", className)}>{children}</div>;
}

export function ProductPageHeader({
  title,
  description,
  backLabel,
  onBack,
  actions,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  backLabel?: string;
  onBack?: () => void;
  actions?: React.ReactNode;
}) {
  return (
    <header className="calmee-titlebar">
      <div className="mx-auto flex min-h-[76px] w-full max-w-[1180px] items-center gap-4 px-7 py-3">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            className="calmee-toolbar-button shrink-0"
            aria-label={backLabel}
            title={backLabel}
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
        )}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[22px] font-semibold leading-7 tracking-[-0.02em] text-foreground">
            {title}
          </h1>
          {description && (
            <p className="mt-0.5 truncate text-[12px] leading-5 text-muted-foreground">
              {description}
            </p>
          )}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}

export function ProductPageContent({ children, className }: React.HTMLAttributes<HTMLDivElement>) {
  return <main className={cn("calmee-content", className)}>{children}</main>;
}

export function SettingsSection({
  title,
  description,
  children,
  className,
}: React.HTMLAttributes<HTMLElement> & {
  title?: React.ReactNode;
  description?: React.ReactNode;
}) {
  return (
    <section className={cn("calmee-panel overflow-hidden", className)}>
      {(title || description) && (
        <div className="border-b border-border/70 px-5 py-4">
          {title && <h2 className="text-[15px] font-semibold tracking-[-0.01em]">{title}</h2>}
          {description && <p className="mt-1 text-[12px] leading-5 text-muted-foreground">{description}</p>}
        </div>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}
