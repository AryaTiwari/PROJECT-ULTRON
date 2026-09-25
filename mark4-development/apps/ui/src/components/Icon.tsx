import type { ReactNode, SVGProps } from "react";

export type IconName = "command"|"mission"|"branches"|"operations"|"sessions"|"plus"|"search"|"attach"|"mic"|"send"|"stop"|"chevron"|"check"|"warning"|"palette"|"close"|"arrow";
export function Icon({name,...props}:{name:IconName}&SVGProps<SVGSVGElement>){
  const base={width:18,height:18,viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:1.65,strokeLinecap:"round" as const,strokeLinejoin:"round" as const,...props};
  const paths:Record<IconName,ReactNode>={
    command:<><path d="M4 5h16v12H9l-5 3V5Z"/><path d="M8 9h8M8 13h5"/></>,
    mission:<><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 2v3M22 12h-3M12 22v-3M2 12h3"/></>,
    branches:<><circle cx="6" cy="5" r="2"/><circle cx="18" cy="7" r="2"/><circle cx="18" cy="18" r="2"/><path d="M8 5h2c5 0 2 13 8 13M12 10c0-2 2-3 4-3"/></>,
    operations:<><path d="M5 5h5v5H5zM14 5h5v5h-5zM5 14h5v5H5zM14 14h5v5h-5z"/></>,
    sessions:<><path d="M4 12a8 8 0 1 0 2.3-5.7L4 8.6"/><path d="M4 4v4.6h4.6M12 8v5l3 2"/></>,
    plus:<path d="M12 5v14M5 12h14"/>,search:<><circle cx="11" cy="11" r="7"/><path d="m16 16 4 4"/></>,
    attach:<path d="m9 12 5.2-5.2a3 3 0 0 1 4.2 4.2l-7.1 7.1a5 5 0 0 1-7.1-7.1l7.1-7.1"/>,
    mic:<><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6"/></>,
    send:<><path d="m5 12 7-7 7 7M12 5v14"/></>,stop:<rect x="7" y="7" width="10" height="10" rx="2"/>,
    chevron:<path d="m9 18 6-6-6-6"/>,check:<path d="m5 12 4 4L19 6"/>,warning:<><path d="M12 3 2.5 20h19L12 3Z"/><path d="M12 9v5M12 17h.01"/></>,
    palette:<><path d="M4 7h16M7 4v6M4 17h16M16 14v6"/></>,close:<path d="m6 6 12 12M18 6 6 18"/>,arrow:<path d="m9 18 6-6-6-6"/>
  };
  return <svg {...base}>{paths[name]}</svg>;
}
