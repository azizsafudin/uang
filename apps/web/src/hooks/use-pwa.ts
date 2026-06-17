import * as React from "react"

// Our manifest declares `"display": "standalone"`, so that's the mode the app
// launches in when installed to the homescreen.
const STANDALONE_QUERY = "(display-mode: standalone)"

// iOS Safari predates `display-mode` and instead exposes a non-standard
// `navigator.standalone` boolean for "Add to Home Screen" launches.
type IosNavigator = Navigator & { standalone?: boolean }

function detectPWA(): boolean {
  if (typeof window === "undefined") return false
  return (
    window.matchMedia(STANDALONE_QUERY).matches ||
    (window.navigator as IosNavigator).standalone === true
  )
}

/**
 * Returns true when the app is running as an installed PWA (launched from the
 * homescreen in standalone mode), false when running in a normal browser tab.
 */
export function useIsPWA() {
  const [isPWA, setIsPWA] = React.useState<boolean | undefined>(undefined)

  React.useEffect(() => {
    const mql = window.matchMedia(STANDALONE_QUERY)
    const onChange = () => setIsPWA(detectPWA())
    mql.addEventListener("change", onChange)
    setIsPWA(detectPWA())
    return () => mql.removeEventListener("change", onChange)
  }, [])

  return !!isPWA
}
