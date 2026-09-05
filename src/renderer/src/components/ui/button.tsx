import type { ButtonHTMLAttributes, ReactElement } from 'react';
import { forwardRef } from 'react';
import { cn } from '../../lib/utils';

type ButtonVariant = 'default' | 'secondary' | 'ghost' | 'outline' | 'destructive';
type ButtonSize = 'default' | 'sm' | 'icon';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
};

const buttonVariants: Record<ButtonVariant, string> = {
  default: 'btn-default',
  secondary: 'btn-secondary',
  ghost: 'btn-ghost',
  outline: 'btn-outline',
  destructive: 'btn-destructive'
};

const buttonSizes: Record<ButtonSize, string> = {
  default: 'btn-size-default',
  sm: 'btn-size-sm',
  icon: 'btn-size-icon'
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'default', size = 'default', ...props }, ref): ReactElement => (
    <button
      ref={ref}
      className={cn('ui-button', buttonVariants[variant], buttonSizes[size], className)}
      {...props}
    />
  )
);

Button.displayName = 'Button';
