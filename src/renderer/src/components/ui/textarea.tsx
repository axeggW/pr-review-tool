import type { TextareaHTMLAttributes, ReactElement } from 'react';
import { forwardRef } from 'react';
import { cn } from '../../lib/utils';

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref): ReactElement => <textarea ref={ref} className={cn('ui-textarea', className)} {...props} />
);

Textarea.displayName = 'Textarea';
