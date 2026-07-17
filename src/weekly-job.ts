import { buildWeeklyDigest } from "./automation.ts"

try {
  console.log(await buildWeeklyDigest())
} catch (cause) {
  console.error(cause)
  process.exit(1)
}
