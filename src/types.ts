export type Row = { id: string; number: string; info: string; carrier?: string; phone?: string; state?: 'success' | 'error' | 'loading'; error?: string };
export type Mapping = { number: string; info: string; carrier?: string; phone?: string };
export type Field = { id: string; name: string; type: number };
export type QueryResult = {
  number: string;
  carrier: string;
  carrierCode?: string;
  state?: string;
  summary: string;
  mock: boolean;
  cached?: boolean;
  queriedAt: string;
  events: { time: string; content: string; status?: string; location?: string }[];
};
