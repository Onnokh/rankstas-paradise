import { syncSearchConsole } from "./automation.ts"

try {
  console.log(await syncSearchConsole())
} catch (cause) {
  console.error(cause)
  process.exit(1)
}
