import type { HTMLAttributes, ReactElement } from 'react';
import { forwardRef } from 'react';
import { cn } from '../../lib/utils';

export const Card = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref): ReactElement => <div ref={ref} className={cn('ui-card', className)} {...props} />
);

export const CardHeader = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref): ReactElement => <div ref={ref} className={cn('ui-card-header', className)} {...props} />
);

export const CardContent = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref): ReactElement => <div ref={ref} className={cn('ui-card-content', className)} {...props} />
);

Card.displayName = 'Card';
CardHeader.displayName = 'CardHeader';
CardContent.displayName = 'CardContent';
