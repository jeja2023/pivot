/**
 * UI 框架与组件环境类型定义（用于离线开发环境与 IDE 类型提示）
 */

namespace JSX {
  interface IntrinsicElements {
    [elemName: string]: any;
  }
  interface Element extends any {}
  interface ElementClass extends any {}
}

namespace React {
  export type FC<P = {}> = (props: P) => any;
  export type ReactNode = any;
  export type ReactElement = any;
  export type ComponentType<P = any> = any;
  export type ChangeEvent<T = any> = any;
  export type KeyboardEvent<T = any> = any;
  export type MouseEvent<T = any> = any;
  export type FormEvent<T = any> = any;
  export const useState: <T = any>(initialState?: T | (() => T)) => [T, (newState: T | ((prevState: T) => T)) => void];
  export const useEffect: (effect: () => void | (() => void), deps?: readonly any[]) => void;
  export const useMemo: <T = any>(factory: () => T, deps: readonly any[] | undefined) => T;
  export const useCallback: <T extends (...args: any[]) => any>(callback: T, deps: readonly any[]) => T;
  export const useRef: <T = any>(initialValue?: T) => { current: T };
  export const Fragment: any;
  export const createElement: any;
  export namespace JSX {
    interface IntrinsicElements {
      [elemName: string]: any;
    }
    interface Element extends any {}
    interface ElementClass extends any {}
  }
}

declare module 'react' {
  export = React;
  export as namespace React;
}

declare module 'react/jsx-runtime' {
  export const jsx: any;
  export const jsxs: any;
  export const Fragment: any;
  export namespace JSX {
    interface IntrinsicElements {
      [elemName: string]: any;
    }
    interface Element extends any {}
    interface ElementClass extends any {}
  }
}

declare module 'react/jsx-dev-runtime' {
  export const jsxDEV: any;
  export const Fragment: any;
  export namespace JSX {
    interface IntrinsicElements {
      [elemName: string]: any;
    }
    interface Element extends any {}
    interface ElementClass extends any {}
  }
}

declare module 'react-router-dom' {
  export const useNavigate: () => (to: any, options?: any) => void;
  export const useParams: <T = Record<string, string>>() => T;
  export const Link: any;
  export const useLocation: () => any;
  const _default: any;
  export default _default;
}

declare module 'react-markdown' {
  const ReactMarkdown: any;
  export default ReactMarkdown;
}

declare module '@mui/material' {
  export const Box: any;
  export const Container: any;
  export const Grid: any;
  export const Card: any;
  export const CardContent: any;
  export const CardMedia: any;
  export const CardActions: any;
  export const Typography: any;
  export const Chip: any;
  export const Button: any;
  export const TextField: any;
  export const Select: any;
  export const MenuItem: any;
  export const FormControl: any;
  export const FormControlLabel: any;
  export const FormHelperText: any;
  export const InputLabel: any;
  export const InputAdornment: any;
  export const Checkbox: any;
  export const Tab: any;
  export const Tabs: any;
  export const Rating: any;
  export const Skeleton: any;
  export const Alert: any;
  export const Switch: any;
  export const Paper: any;
  export const Divider: any;
  export const Stack: any;
  export const CircularProgress: any;
  export const Breadcrumbs: any;
  export const IconButton: any;
  export const Tooltip: any;
  export const Dialog: any;
  export const DialogTitle: any;
  export const DialogContent: any;
  export const DialogActions: any;
  export const Avatar: any;
  export const List: any;
  export const ListItem: any;
  export const ListItemText: any;
  const _default: any;
  export default _default;
}

declare module '@mui/material/*' {
  const content: any;
  export default content;
}

declare module '@mui/icons-material' {
  export const Search: any;
  export const TrendingUp: any;
  export const Star: any;
  export const Schedule: any;
  export const AccountTree: any;
  export const ArrowBack: any;
  export const PlayArrow: any;
  export const CheckCircle: any;
  export const Edit: any;
  export const Delete: any;
  export const Share: any;
  export const ContentCopy: any;
  export const Visibility: any;
  export const Description: any;
  export const Code: any;
  export const RateReview: any;
  const _default: any;
  export default _default;
}

declare module '@mui/icons-material/*' {
  const content: any;
  export default content;
}
