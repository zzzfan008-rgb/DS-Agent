'use client';

import type { ReactNode } from 'react';
import type { ApiFailure } from '@/lib/api';
import { ErrorState } from './ErrorState';
import { Skeleton, type SkeletonVariant } from './Skeleton';

export type AsyncState = 'loading' | 'error' | 'empty' | 'ready';

export interface AsyncSectionProps {
  state: AsyncState;
  error?: ApiFailure | null;
  onRetry?: () => void;
  empty?: ReactNode;
  skeleton?: ReactNode;
  skeletonVariant?: SkeletonVariant;
  children: ReactNode;
}

/**
 * 四态编排（docs/13 §2.3）：区块级 loading/error/empty/ready，支持局部失败不整页报错。
 */
export function AsyncSection({
  state,
  error,
  onRetry,
  empty,
  skeleton,
  skeletonVariant = 'list',
  children,
}: AsyncSectionProps) {
  if (state === 'loading') return <>{skeleton ?? <Skeleton variant={skeletonVariant} />}</>;
  if (state === 'error') {
    return (
      <ErrorState
        title="区块加载失败"
        code={error?.code}
        message={error?.message}
        requestId={error?.requestId}
        nextAction={error?.nextAction}
        onRetry={onRetry}
      />
    );
  }
  if (state === 'empty') return <>{empty}</>;
  return <>{children}</>;
}
