import type { HTMLAttributes } from 'react'
import {
  MessageSquare,
  Video,
  Film,
  LayoutGrid,
  Terminal,
  Settings,
  Palette,
  Bot,
  Camera,
  Scissors,
  Gauge,
  Type,
  Languages,
  Mic,
  Play,
  RefreshCw,
  Send,
  Pin,
  ArrowLeft,
  ArrowRight,
  Images,
  Users,
  Image,
  Edit3,
  Briefcase,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'

export type FluentIconName =
  | 'Chat'
  | 'Video'
  | 'Movie'
  | 'Tiles'
  | 'CommandPrompt'
  | 'Setting'
  | 'Palette'
  | 'Robot'
  | 'Camera'
  | 'Cut'
  | 'SpeedHigh'
  | 'Font'
  | 'Language'
  | 'Microphone'
  | 'Play'
  | 'Sync'
  | 'Send'
  | 'Pin'
  | 'LeftArrow'
  | 'RightArrow'
  | 'Album'
  | 'People'
  | 'Photo'
  | 'Edit'
  | 'Work'

const LUCIDE_MAP: Record<FluentIconName, LucideIcon> = {
  Chat: MessageSquare,
  Video: Video,
  Movie: Film,
  Tiles: LayoutGrid,
  CommandPrompt: Terminal,
  Setting: Settings,
  Palette: Palette,
  Robot: Bot,
  Camera: Camera,
  Cut: Scissors,
  SpeedHigh: Gauge,
  Font: Type,
  Language: Languages,
  Microphone: Mic,
  Play: Play,
  Sync: RefreshCw,
  Send: Send,
  Pin: Pin,
  LeftArrow: ArrowLeft,
  RightArrow: ArrowRight,
  Album: Images,
  People: Users,
  Photo: Image,
  Edit: Edit3,
  Work: Briefcase,
}

interface Props extends Omit<HTMLAttributes<HTMLSpanElement>, 'color'> {
  name: FluentIconName
  size?: number
  color?: string
}

export default function FluentIcon({
  name,
  size = 18,
  color,
  className,
  style,
  ...rest
}: Props) {
  const IconComponent = LUCIDE_MAP[name] || MessageSquare
  return (
    <span
      {...rest}
      className={cn('inline-flex items-center justify-center shrink-0', className)}
      style={{ color: color || 'inherit', ...style }}
    >
      <IconComponent size={size} style={{ flexShrink: 0 }} />
    </span>
  )
}
