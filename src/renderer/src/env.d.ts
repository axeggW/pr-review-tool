import type { ReviewApi } from '../../shared/types';

declare global {
  interface Window {
    reviewApi?: ReviewApi;
  }
}

export {};
