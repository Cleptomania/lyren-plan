import type { UserDTO } from '@shared/types';
import type { UserRow } from './sessions';

export function toUserDTO(row: UserRow): UserDTO {
  return { id: row.id, username: row.username, displayName: row.display_name, createdAt: row.created_at };
}
