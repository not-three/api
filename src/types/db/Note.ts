export interface Note {
  id: string;
  content: string;
  ip: string;
  created_at: number;
  expires_at: number;
  self_destruct: boolean;
  delete_token: string | null;
  mime: string | null;
}

export type NoteInsert = Omit<Omit<Note, 'id'>, 'created_at'>;
