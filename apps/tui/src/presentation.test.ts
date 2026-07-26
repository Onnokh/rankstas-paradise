import { expect, test } from "bun:test"
import { BoxRenderable, TextRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"

import { detailSummaryHeight, masterVisibleRowLimit } from "./presentation.ts"

const renderRegistrySummary = async (
  rendererWidth: number,
  detailWidth: number,
) => {
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
    width: detailWidth,
    height: 20,
  })
  const detail = new BoxRenderable(renderer, {
    width: "100%",
    height: "100%",
    overflow: "hidden",
    borderStyle: "single",
    padding: 1,
    flexDirection: "column",
  })
  const summary = new BoxRenderable(renderer, {
    height: detailSummaryHeight(true, rendererWidth),
    flexShrink: 0,
    minWidth: 0,
    overflow: "hidden",
    border: ["bottom"],
    borderStyle: "single",
    paddingBottom: 1,
    flexDirection: "column",
  })
  summary.add(new TextRenderable(renderer, {
    height: 1,
    flexShrink: 0,
    content: "/ios-app",
  }))
  const summaryBody = new TextRenderable(renderer, {
    flexGrow: 1,
    minHeight: 0,
    overflow: "hidden",
    content: "",
  })
  summary.add(summaryBody)
  detail.add(summary)
  detail.add(new BoxRenderable(renderer, {
    flexGrow: 1,
    minHeight: 0,
  }))
  renderer.root.add(detail)

  await renderOnce()
  summaryBody.content = [
    "Page: /ios-app",
    "Current 28 days: 0 impressions",
    "Previous baseline: 0 impressions",
    "Search intent: Product / how-to",
    "Registry: P0 · USA · 4 keywords",
    "Google index: Discovered - currently not indexed",
  ].join("\n")
  await renderOnce()

  const frame = captureCharFrame().replaceAll(/\s+/g, " ")
  renderer.destroy()
  return frame
}

test("masterVisibleRowLimit subtracts base chrome from renderer height", () => {
  expect(masterVisibleRowLimit(40, { hasTableHeader: false })).toBe(28)
})

test("masterVisibleRowLimit subtracts one row when the table has a header", () => {
  expect(masterVisibleRowLimit(40, { hasTableHeader: true })).toBe(27)
})

test("masterVisibleRowLimit subtracts extra chrome for future strips", () => {
  expect(masterVisibleRowLimit(40, { hasTableHeader: false, extraChrome: 5 })).toBe(23)
})

test("masterVisibleRowLimit never returns less than one visible row", () => {
  expect(masterVisibleRowLimit(5, { hasTableHeader: true, extraChrome: 5 })).toBe(1)
})

test("registry detail summary leaves room for the Google index line", async () => {
  const expected = "Google index: Discovered - currently not indexed"
  const narrow = await renderRegistrySummary(80, 40)

  expect(await renderRegistrySummary(200, 104)).toContain(expected)
  expect(narrow).toContain("Google index: Discovered -")
  expect(narrow).toContain("currently not indexed")
})
