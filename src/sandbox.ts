// Re-export the SDK's Sandbox class under the binding name wrangler expects.
// Wrangler's DO migration is configured for class_name "HermesSandbox", so
// the runtime needs to find an exported class with that name.
export { Sandbox as HermesSandbox } from "@cloudflare/sandbox";
