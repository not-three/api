export interface File {
  id: string;
  name: string;
  ip: string;
  upload_id: string | null;
  part: number;
  created_at: number;
  updated_at: number;
  expires_at: number;
}

export type FileInsert = Omit<
  Omit<Omit<File, "id">, "updated_at">,
  "created_at"
>;
