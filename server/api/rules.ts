import { z } from "zod";

export const Credentials = z.object({
  username: z.string().regex(/^[A-Za-z0-9_-]{3,32}$/, "Username must be 3–32 letters, digits, _ or -."),
  password: z.string().min(10, "Password must be at least 10 characters.").max(1024),
}).strict();
export type Credentials = z.infer<typeof Credentials>;
