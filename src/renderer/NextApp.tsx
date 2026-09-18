import ScenePage from './components/scene/ScenePage'
import { I18nProvider } from './i18n'
import { usePiRuntime } from './usePiRuntime'
import SceneVoiceBridge from './SceneVoiceBridge'

export default function NextApp() {
  const runtime = usePiRuntime()
  return (
    <I18nProvider connected={runtime.connected} send={runtime.send} subscribe={runtime.subscribe}>
      <SceneVoiceBridge runtime={runtime} />
      <ScenePage
        send={runtime.send}
        subscribe={runtime.subscribe}
        connected={runtime.connected}
      />
    </I18nProvider>
  )
}
