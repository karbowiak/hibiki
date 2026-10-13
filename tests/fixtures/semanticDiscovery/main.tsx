import React from "react"
import { createRoot } from "react-dom/client"
import { SemanticDiscoverySettings } from "../../../src/components/Settings/SemanticDiscoverySettings"
import { createEmbeddingWorker } from "../../../src/semantic/workerClient"
const styles = document.createElement("style")
styles.textContent =
  ":root{--bg-surface:#21232b;--bg-elevated:#303340;--border:#454956;--text-primary:#f6f6fa;--text-secondary:#bfc4d0;--accent-ink:#131318}body{background:#181a20;color:#f6f6fa;font:16px system-ui;margin:24px}button{padding:12px;margin:8px;cursor:pointer}"
document.head.append(styles)
createRoot(document.getElementById("root")!).render(
  <SemanticDiscoverySettings />
)
;(window as any).testEmbeddings = async () => {
  const worker = await createEmbeddingWorker()
  try {
    const docs = [
      "Quiet instrumental piano, soft acoustic textures and slow ambient passages for relaxation.",
      "Aggressive heavy metal guitar riffs, shouted vocals and rapid drums.",
      "Energetic electronic dance music with driving beats for workouts.",
      "Intimate melancholic folk ballads about grief and longing.",
      "Joyful upbeat soul songs with bright brass and celebratory singing.",
    ]
    const queries = [
      "Something soothing without singers to unwind after work",
      "Loud distorted riffs for headbanging",
      "Music that motivates me to exercise",
      "Sad acoustic storytelling",
      "A cheerful celebration with horns",
    ]
    const d = await worker.embed(docs)
    const q = await worker.embed(queries)
    const top = q.map(
      (v) =>
        d
          .map((doc, index) => ({
            index,
            score: doc.reduce((sum, x, j) => sum + x * v[j], 0),
          }))
          .sort((a, b) => b.score - a.score)[0].index
    )
    const bounded = (await worker.embed(["piano ".repeat(1000)]))[0]
    return {
      top,
      dimensions: d[0].length,
      norms: d.map((v) => v.reduce((sum, x) => sum + x * x, 0)),
      longNorm: bounded.reduce((sum, x) => sum + x * x, 0),
    }
  } finally {
    worker.close()
  }
}
