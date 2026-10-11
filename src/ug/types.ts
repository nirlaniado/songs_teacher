export interface SongIdentity { title: string; artist: string }
export interface TabCandidate {
  id: string;
  title: string;
  artist: string;
  url: string;
  official: boolean;
  version: number | null;
  views: number | null;
}
export interface ChordLine {
  section: string | null;
  sourceLine: number;
  chords: string[];
  /** The chords positioned as on the source page, spaces preserved, so they line up over `lyric`. */
  row: string;
  /** The words sung under this chord line, or null (an instrumental line). */
  lyric: string | null;
}
export interface ChordResult {
  source: TabCandidate;
  retrievedAt: string;
  selection: "official" | "most_viewed" | "user_selected";
  warning: string | null;
  capo: number | null;
  tuning: string | null;
  key: string | null;
  lines: ChordLine[];
  uniqueChords: string[];
  chart: string;
}
export interface AgentJob {
  id: string;
  query: string;
  identity?: SongIdentity;
  status: "running" | "needs_login" | "needs_choice" | "done" | "error";
  message: string;
  events: string[];
  candidates?: TabCandidate[];
  result?: ChordResult;
}
