export interface SemanticDocument {
  kind: "artist" | "album" | "track" | "playlist"
  id: string
  title: string
  artist: string
  text: string
  textHash: string
  indexed?: boolean
}
export interface SemanticMatch {
  kind: SemanticDocument["kind"]
  id: string
  title: string
  artist: string
  score: number
}
export interface SemanticEmbedding {
  kind: SemanticDocument["kind"]
  id: string
  textHash: string
  vector: number[]
}
