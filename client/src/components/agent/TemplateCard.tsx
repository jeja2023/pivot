/// <reference path="../../shims-ui.d.ts" />
/**
 * 模板展示卡片组件
 */

import React, { FC } from 'react';
import {
  Card,
  CardContent,
  CardMedia,
  Typography,
  Chip,
  Box,
  Rating,
  Button
} from '@mui/material';
import {
  Schedule as ScheduleIcon,
  TrendingUp as TrendingUpIcon
} from '@mui/icons-material';

export interface WorkflowTemplateItem {
  id: number;
  name: string;
  slug: string;
  description: string;
  tags?: string[];
  difficulty?: 'beginner' | 'intermediate' | 'advanced';
  estimated_time?: string;
  icon?: string;
  preview_image?: string;
  usage_count?: number;
  rating_avg?: number;
  rating_count?: number;
  category_name?: string;
  is_builtin?: boolean;
}

interface TemplateCardProps {
  template: WorkflowTemplateItem;
  onSelect?: (template: WorkflowTemplateItem) => void;
}

const difficultyColors: Record<string, 'success' | 'warning' | 'error' | 'default'> = {
  beginner: 'success',
  intermediate: 'warning',
  advanced: 'error'
};

const difficultyLabels: Record<string, string> = {
  beginner: '初级',
  intermediate: '中级',
  advanced: '高级'
};

export const TemplateCard: FC<TemplateCardProps> = ({ template, onSelect }) => {
  return (
    <Card
      sx={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        transition: 'transform 0.2s, box-shadow 0.2s',
        '&:hover': {
          transform: 'translateY(-4px)',
          boxShadow: 4,
          cursor: 'pointer'
        }
      }}
      onClick={() => onSelect && onSelect(template)}
    >
      {template.preview_image && (
        <CardMedia
          component="img"
          height="140"
          image={template.preview_image}
          alt={template.name}
          sx={{ objectFit: 'cover' }}
        />
      )}
      <CardContent sx={{ flexGrow: 1, display: 'flex', flexDirection: 'column' }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', mb: 1 }}>
          <Typography variant="h6" component="h2" noWrap sx={{ fontWeight: 600, fontSize: '1.1rem' }}>
            {template.name}
          </Typography>
          {template.difficulty && (
            <Chip
              label={difficultyLabels[template.difficulty] || template.difficulty}
              color={difficultyColors[template.difficulty] || 'default'}
              size="small"
            />
          )}
        </Box>

        <Typography
          variant="body2"
          color="text.secondary"
          sx={{
            mb: 2,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            minHeight: '2.6em'
          }}
        >
          {template.description}
        </Typography>

        <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mb: 2 }}>
          {(template.tags || []).slice(0, 3).map((tag: string, i: number) => (
            <Chip key={i} label={tag} size="small" variant="outlined" />
          ))}
        </Box>

        <Box sx={{ mt: 'auto', display: 'flex', justifyContent: 'space-between', alignItems: 'center', pt: 1, borderTop: '1px solid #f0f0f0' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <Rating value={Number(template.rating_avg) || 5} precision={0.5} size="small" readOnly />
            <Typography variant="caption" color="text.secondary">
              ({template.rating_count || 0})
            </Typography>
          </Box>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, color: 'text.secondary', fontSize: '0.75rem' }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.25 }}>
              <TrendingUpIcon sx={{ fontSize: 14 }} />
              <span>{template.usage_count || 0}</span>
            </Box>
            {template.estimated_time && (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.25 }}>
                <ScheduleIcon sx={{ fontSize: 14 }} />
                <span>{template.estimated_time}</span>
              </Box>
            )}
          </Box>
        </Box>
      </CardContent>
    </Card>
  );
};

export default TemplateCard;
