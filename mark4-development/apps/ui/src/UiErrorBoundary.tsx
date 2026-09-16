import React from "react";

type State={error:Error|null};

export class UiErrorBoundary extends React.Component<React.PropsWithChildren,State>{
  state:State={error:null};
  static getDerivedStateFromError(error:Error){return{error};}
  componentDidCatch(error:Error,info:React.ErrorInfo){
    console.error("ULTRON UI render failure",error,info);
    const show=(window as any).__showUltronFatal;
    if(typeof show==="function")show((error.stack||error.message)+"\n\n"+info.componentStack);
  }
  render(){
    if(this.state.error){
      return <div className="u4-boundary">
        <div className="u4-boundary-core">U</div>
        <span>MARK 4 / UI FAILURE</span>
        <h1>The cockpit hit a render error.</h1>
        <pre>{this.state.error.stack||this.state.error.message}</pre>
      </div>;
    }
    return this.props.children;
  }
}
