// Buttons. Every clickable control in the app is one of these (or a ButtonLink for navigation).

import { clsx } from 'clsx';
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Link, type LinkProps } from 'react-router';
import { Spinner } from './Spinner';
import { Tooltip } from './Tooltip';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

const BASE =
  'relative inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium ' +
  'transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 ' +
  'disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-fg shadow-card hover:bg-accent-hover active:brightness-95',
  secondary: 'border border-border bg-surface text-fg shadow-card hover:border-border-strong hover:bg-surface-2 active:bg-surface-3',
  ghost: 'text-fg-muted hover:bg-surface-2 hover:text-fg active:bg-surface-3',
  danger: 'bg-danger text-danger-fg shadow-card hover:bg-danger-hover active:brightness-95',
};

// Mobile sizes keep a 40px touch target; desktop is denser.
const SIZES: Record<ButtonSize, string> = {
  sm: 'h-10 px-3 text-sm md:h-8 md:px-2.5 md:text-[13px]',
  md: 'h-10 px-3.5 text-sm md:h-9 md:px-3',
};

const ICON_SIZES: Record<ButtonSize, string> = {
  sm: 'size-10 md:size-8',
  md: 'size-10 md:size-9',
};

export interface ButtonStyleOptions {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  className?: string;
}

/** Class string for button-looking elements (e.g. a react-router <Link>). */
export function buttonClasses({ variant = 'secondary', size = 'md', fullWidth, className }: ButtonStyleOptions = {}): string {
  return clsx(BASE, VARIANTS[variant], SIZES[size], fullWidth && 'w-full', className);
}

/** Class string for square icon-only buttons. */
export function iconButtonClasses({ variant = 'ghost', size = 'md', className }: Omit<ButtonStyleOptions, 'fullWidth'> = {}): string {
  return clsx(BASE, VARIANTS[variant], ICON_SIZES[size], className);
}

interface ButtonContentProps {
  icon?: ReactNode;
  trailingIcon?: ReactNode;
  loading?: boolean;
  hideLabelOnMobile?: boolean;
  children?: ReactNode;
}

function ButtonContent({ icon, trailingIcon, loading, hideLabelOnMobile, children }: ButtonContentProps) {
  return (
    <>
      {loading ? <Spinner size="sm" label={null} /> : icon}
      {children !== undefined && children !== null && children !== false && (
        <span className={clsx('truncate', hideLabelOnMobile && 'max-md:sr-only')}>{children}</span>
      )}
      {trailingIcon}
    </>
  );
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, ButtonStyleOptions {
  /** Leading icon (lucide icon, sized automatically). Replaced by a spinner while loading. */
  icon?: ReactNode;
  trailingIcon?: ReactNode;
  /** Shows a spinner and disables the button. */
  loading?: boolean;
  /** Below md, show only the icon (the label stays available to screen readers). */
  hideLabelOnMobile?: boolean;
}

/**
 * Button. Defaults: variant 'secondary', size 'md', type 'button'.
 * Icons passed via `icon` should be lucide icons; they are sized to 16px.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', fullWidth, className, icon, trailingIcon, loading, hideLabelOnMobile, disabled, type, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={clsx(buttonClasses({ variant, size, fullWidth }), '[&_svg]:size-4 [&_svg]:shrink-0', hideLabelOnMobile && 'max-md:px-0 max-md:w-10', className)}
      {...rest}
    >
      <ButtonContent icon={icon} trailingIcon={trailingIcon} loading={loading} hideLabelOnMobile={hideLabelOnMobile}>
        {children}
      </ButtonContent>
    </button>
  );
});

export interface ButtonLinkProps extends Omit<LinkProps, 'className'>, ButtonStyleOptions {
  icon?: ReactNode;
  trailingIcon?: ReactNode;
  hideLabelOnMobile?: boolean;
}

/** A react-router Link that looks like a Button (for navigation actions). */
export const ButtonLink = forwardRef<HTMLAnchorElement, ButtonLinkProps>(function ButtonLink(
  { variant = 'secondary', size = 'md', fullWidth, className, icon, trailingIcon, hideLabelOnMobile, children, ...rest },
  ref,
) {
  return (
    <Link
      ref={ref}
      className={clsx(buttonClasses({ variant, size, fullWidth }), '[&_svg]:size-4 [&_svg]:shrink-0', hideLabelOnMobile && 'max-md:px-0 max-md:w-10', className)}
      {...rest}
    >
      <ButtonContent icon={icon} trailingIcon={trailingIcon} hideLabelOnMobile={hideLabelOnMobile}>
        {children}
      </ButtonContent>
    </Link>
  );
});

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'aria-label'> {
  /** Required: icon-only buttons need an accessible name. Also used as the tooltip text. */
  'aria-label': string;
  icon: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  /** Desktop hover/focus tooltip. `true` (default) shows the aria-label; a string overrides it. */
  tooltip?: boolean | string;
  /** Visual pressed state for toggle buttons (sets aria-pressed). */
  pressed?: boolean;
}

/** Square icon-only button (default variant 'ghost'). */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { 'aria-label': label, icon, variant = 'ghost', size = 'md', loading, tooltip = true, pressed, className, disabled, type, ...rest },
  ref,
) {
  const button = (
    <button
      ref={ref}
      type={type ?? 'button'}
      aria-label={label}
      aria-pressed={pressed}
      aria-busy={loading || undefined}
      disabled={disabled || loading}
      className={clsx(
        iconButtonClasses({ variant, size }),
        '[&_svg]:size-4 [&_svg]:shrink-0',
        pressed && variant === 'ghost' && 'bg-surface-3 text-fg',
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner size="sm" label={null} /> : icon}
    </button>
  );
  if (!tooltip) return button;
  return <Tooltip content={typeof tooltip === 'string' ? tooltip : label}>{button}</Tooltip>;
});
