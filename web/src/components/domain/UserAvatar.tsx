import { clsx } from 'clsx';
import type { UserRef } from '@shared/types';
import { Avatar } from '../ui';

export interface UserAvatarProps {
  /** Author/actor; null = a deleted or unknown user. */
  user: Pick<UserRef, 'displayName'> | null | undefined;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  /** Show the display name next to the initials. */
  showName?: boolean;
  className?: string;
}

const UNKNOWN = 'Unknown user';

/** Initials avatar for a user. Without `showName` the name is exposed as the accessible label. */
export function UserAvatar({ user, size = 'sm', showName, className }: UserAvatarProps) {
  const name = user?.displayName.trim() || UNKNOWN;
  if (!showName) {
    return (
      <span role="img" aria-label={name} className={clsx('inline-flex shrink-0', className)}>
        <Avatar name={user ? name : '?'} size={size} />
      </span>
    );
  }
  return (
    <span className={clsx('inline-flex min-w-0 items-center gap-2', className)}>
      <Avatar name={user ? name : '?'} size={size} />
      <span className={clsx('min-w-0 truncate', !user && 'italic text-fg-muted')}>{name}</span>
    </span>
  );
}
