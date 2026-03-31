export interface PlainInput {
  type: "plain";
  value: string;
}

export interface Citation {
  type: "transcript" | "uri" | "command";
  source?: string;
  command?: string;
  excerpt: string;
}

export interface EvidencedInput {
  type: "evidenced";
  body: string;
  citations: Citation[];
}

export type InputEntry = PlainInput | EvidencedInput;
