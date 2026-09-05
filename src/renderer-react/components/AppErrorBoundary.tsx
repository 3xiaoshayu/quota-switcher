import { Component, type ErrorInfo, type ReactNode } from 'react';

interface AppErrorBoundaryProps {
  children: ReactNode;
}

interface AppErrorBoundaryState {
  message: string | null;
}

// A render error anywhere in the tree used to leave a blank window with no way
// out except killing the process. This keeps the failure on screen and offers
// a reload; the daemon and the main process are unaffected.
export default class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { message: null };

  static getDerivedStateFromError(error: unknown): AppErrorBoundaryState {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('Renderer crashed', error, info.componentStack);
  }

  render() {
    if (this.state.message === null) return this.props.children;
    return <RendererCrashScreen message={this.state.message} />;
  }
}

export function RendererCrashScreen({ message }: { message: string }) {
  return (
    <div
      className="h-screen w-screen bg-base text-label flex items-center justify-center p-8 select-none app-drag"
      id="renderer-crash-screen"
    >
      <div className="glass-card rounded-2xl p-8 max-w-[520px] w-full app-no-drag">
        <h1 className="text-[20px] font-bold tracking-tight">界面出错了</h1>
        <p className="mt-2 text-[13px] text-label-2 leading-relaxed">
          账号和后台任务都没有受影响。重新加载界面即可继续；如果反复出现，请把下面这行文字发到 GitHub Issues。
        </p>
        <pre
          className="mt-4 max-h-40 overflow-auto rounded-xl bg-fill p-3 text-[12px] text-label-2 whitespace-pre-wrap break-all font-mono"
          id="renderer-crash-message"
        >
          {message}
        </pre>
        <div className="mt-5 flex justify-end">
          <button
            type="button"
            className="px-4 py-2 rounded-[10px] bg-accent hover:bg-accent-hi text-white text-[13px] font-medium cursor-pointer"
            onClick={() => window.location.reload()}
            id="renderer-crash-reload"
          >
            重新加载
          </button>
        </div>
      </div>
    </div>
  );
}
