/** Node ignores this optional cache on unsupported runtimes or unwritable paths.
 * Never override a user-provided location or an explicit cache opt-out. */
export function withRuntimeCompileCache(env: NodeJS.ProcessEnv, cachePath?: string): NodeJS.ProcessEnv {
  if (!cachePath || env.NODE_COMPILE_CACHE || env.NODE_DISABLE_COMPILE_CACHE === "1") return env;
  return { ...env, NODE_COMPILE_CACHE: cachePath };
}
