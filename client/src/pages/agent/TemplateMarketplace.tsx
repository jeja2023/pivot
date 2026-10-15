/// <reference path="../../shims-ui.d.ts" />
/**
 * 工作流模板商城
 *
 * 功能：
 * - 模板浏览（网格/列表视图）
 * - 分类筛选
 * - 搜索
 * - 排序
 * - 模板详情查看
 */

import React, { FC, useState, useEffect } from 'react';
import {
  Box,
  Container,
  Grid,
  Card,
  CardContent,
  CardMedia,
  Typography,
  Chip,
  Button,
  TextField,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  InputAdornment,
  Tab,
  Tabs,
  Rating,
  Skeleton,
  Alert
} from '@mui/material';
import {
  Search as SearchIcon,
  TrendingUp as TrendingUpIcon,
  Star as StarIcon,
  Schedule as ScheduleIcon,
  AccountTree as AccountTreeIcon
} from '@mui/icons-material';
import { useNavigate } from 'react-router-dom';
import { workflowTemplateService } from '../../services/agent/workflowTemplateService';

interface Template {
  id: number;
  name: string;
  slug: string;
  description: string;
  tags: string[];
  difficulty: 'beginner' | 'intermediate' | 'advanced';
  estimated_time: string;
  icon: string;
  preview_image: string;
  usage_count: number;
  rating_avg: number;
  rating_count: number;
  category_name: string;
  category_slug: string;
  author_nickname: string;
  is_builtin?: boolean;
}

interface Category {
  id: number;
  name: string;
  slug: string;
  icon: string;
}

const TemplateMarketplace: FC = () => {
  const navigate = useNavigate();

  // 状态
  const [templates, setTemplates] = useState<Template[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 筛选和排序
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [difficulty, setDifficulty] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<'usage_count' | 'rating_avg' | 'created_at'>('usage_count');

  // 分页
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  // 加载数据
  useEffect(() => {
    loadCategories();
  }, []);

  useEffect(() => {
    loadTemplates();
  }, [selectedCategory, difficulty, sortBy, page]);

  const loadCategories = async () => {
    try {
      const data = await workflowTemplateService.getCategories();
      setCategories(data);
    } catch (err: any) {
      console.error('Failed to load categories:', err);
    }
  };

  const loadTemplates = async () => {
    setLoading(true);
    setError(null);

    try {
      const result = await workflowTemplateService.listTemplates({
        category: selectedCategory === 'all' ? undefined : selectedCategory,
        difficulty: difficulty === 'all' ? undefined : difficulty,
        search: searchQuery || undefined,
        sortBy,
        sortOrder: 'desc',
        page,
        pageSize: 12
      });

      setTemplates(result.templates);
      setTotalPages(result.pagination.totalPages);
    } catch (err: any) {
      setError(err.message || '加载模板失败');
    } finally {
      setLoading(false);
    }
  };

  const handleSearch = () => {
    setPage(1);
    loadTemplates();
  };

  const handleTemplateClick = (slug: string) => {
    navigate(`/agent/templates/${slug}`);
  };

  const getDifficultyLabel = (difficulty: string) => {
    const labels: Record<string, string> = {
      beginner: '入门',
      intermediate: '进阶',
      advanced: '高级'
    };
    return labels[difficulty] || difficulty;
  };

  const getDifficultyColor = (difficulty: string) => {
    const colors: Record<string, any> = {
      beginner: 'success',
      intermediate: 'warning',
      advanced: 'error'
    };
    return colors[difficulty] || 'default';
  };

  return (
    <Container maxWidth="xl" sx={{ py: 4 }}>
      {/* 标题 */}
      <Box sx={{ mb: 4 }}>
        <Typography variant="h4" fontWeight="bold" gutterBottom>
          工作流模板商城
        </Typography>
        <Typography variant="body1" color="text.secondary">
          选择模板，快速开始，5 分钟创建专业工作流
        </Typography>
      </Box>

      {/* 筛选栏 */}
      <Box sx={{ mb: 4 }}>
        <Grid container spacing={2} alignItems="center">
          {/* 搜索 */}
          <Grid item xs={12} md={4}>
            <TextField
              fullWidth
              size="small"
              placeholder="搜索模板..."
              value={searchQuery}
              onChange={(e: any) => setSearchQuery(e.target.value)}
              onKeyPress={(e: any) => e.key === 'Enter' && handleSearch()}
              InputProps={{
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon />
                  </InputAdornment>
                ),
              }}
            />
          </Grid>

          {/* 难度筛选 */}
          <Grid item xs={12} sm={6} md={2}>
            <FormControl fullWidth size="small">
              <InputLabel>难度</InputLabel>
              <Select
                value={difficulty}
                label="难度"
                onChange={(e: any) => setDifficulty(e.target.value)}
              >
                <MenuItem value="all">全部</MenuItem>
                <MenuItem value="beginner">入门</MenuItem>
                <MenuItem value="intermediate">进阶</MenuItem>
                <MenuItem value="advanced">高级</MenuItem>
              </Select>
            </FormControl>
          </Grid>

          {/* 排序 */}
          <Grid item xs={12} sm={6} md={2}>
            <FormControl fullWidth size="small">
              <InputLabel>排序</InputLabel>
              <Select
                value={sortBy}
                label="排序"
                onChange={(e: any) => setSortBy(e.target.value as any)}
              >
                <MenuItem value="usage_count">
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <TrendingUpIcon fontSize="small" />
                    最热门
                  </Box>
                </MenuItem>
                <MenuItem value="rating_avg">
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <StarIcon fontSize="small" />
                    最高分
                  </Box>
                </MenuItem>
                <MenuItem value="created_at">
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <ScheduleIcon fontSize="small" />
                    最新
                  </Box>
                </MenuItem>
              </Select>
            </FormControl>
          </Grid>

          {/* 搜索按钮 */}
          <Grid item xs={12} md={2}>
            <Button
              fullWidth
              variant="contained"
              onClick={handleSearch}
            >
              搜索
            </Button>
          </Grid>
        </Grid>
      </Box>

      {/* 分类标签 */}
      <Box sx={{ mb: 3 }}>
        <Tabs
          value={selectedCategory}
          onChange={(_: any, value: any) => {
            setSelectedCategory(value);
            setPage(1);
          }}
          variant="scrollable"
          scrollButtons="auto"
        >
          <Tab label="全部" value="all" />
          {categories.map((cat: any) => (
            <Tab key={cat.id} label={cat.name} value={cat.slug} />
          ))}
        </Tabs>
      </Box>

      {/* 错误提示 */}
      {error && (
        <Alert severity="error" sx={{ mb: 3 }}>
          {error}
        </Alert>
      )}

      {/* 模板网格 */}
      {loading ? (
        <Grid container spacing={3}>
          {[1, 2, 3, 4, 5, 6].map((i: number) => (
            <Grid item xs={12} sm={6} md={4} key={i}>
              <Card>
                <Skeleton variant="rectangular" height={180} />
                <CardContent>
                  <Skeleton variant="text" height={32} />
                  <Skeleton variant="text" height={20} />
                  <Skeleton variant="text" height={20} width="60%" />
                </CardContent>
              </Card>
            </Grid>
          ))}
        </Grid>
      ) : templates.length === 0 ? (
        <Box sx={{ textAlign: 'center', py: 8 }}>
          <Typography variant="h6" color="text.secondary" gutterBottom>
            没有找到匹配的模板
          </Typography>
          <Typography variant="body2" color="text.secondary">
            试试调整筛选条件或搜索关键词
          </Typography>
        </Box>
      ) : (
        <Grid container spacing={3}>
          {templates.map((template: Template) => (
            <Grid item xs={12} sm={6} md={4} key={template.id}>
              <Card
                sx={{
                  height: '100%',
                  display: 'flex',
                  flexDirection: 'column',
                  cursor: 'pointer',
                  transition: 'all 0.2s',
                  '&:hover': {
                    transform: 'translateY(-4px)',
                    boxShadow: 4,
                  },
                }}
                onClick={() => handleTemplateClick(template.slug)}
              >
                {/* 预览图 */}
                <CardMedia
                  component="div"
                  sx={{
                    height: 180,
                    backgroundColor: 'grey.100',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 64,
                  }}
                >
                  {template.preview_image ? (
                    <img
                      src={template.preview_image}
                      alt={template.name}
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    />
                  ) : (
                    <AccountTreeIcon sx={{ fontSize: 48, color: 'text.secondary' }} />
                  )}
                </CardMedia>

                <CardContent sx={{ flexGrow: 1, display: 'flex', flexDirection: 'column' }}>
                  {/* 标题 */}
                  <Typography variant="h6" fontWeight="bold" gutterBottom>
                    {template.name}
                  </Typography>

                  {/* 描述 */}
                  <Typography
                    variant="body2"
                    color="text.secondary"
                    sx={{
                      flexGrow: 1,
                      mb: 2,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      display: '-webkit-box',
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: 'vertical',
                    }}
                  >
                    {template.description}
                  </Typography>

                  {/* 标签 */}
                  <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mb: 2 }}>
                    <Chip
                      label={getDifficultyLabel(template.difficulty)}
                      size="small"
                      color={getDifficultyColor(template.difficulty)}
                    />
                    <Chip
                      label={template.estimated_time}
                      size="small"
                      variant="outlined"
                    />
                    {template.tags.slice(0, 2).map((tag: string) => (
                      <Chip key={tag} label={tag} size="small" variant="outlined" />
                    ))}
                  </Box>

                  {/* 底部信息 */}
                  <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                      <Rating value={template.rating_avg} precision={0.1} size="small" readOnly />
                      <Typography variant="caption" color="text.secondary">
                        ({template.rating_count})
                      </Typography>
                    </Box>
                    <Typography variant="caption" color="text.secondary">
                      {template.usage_count} 次使用
                    </Typography>
                  </Box>
                </CardContent>
              </Card>
            </Grid>
          ))}
        </Grid>
      )}

      {/* 分页 */}
      {!loading && totalPages > 1 && (
        <Box sx={{ display: 'flex', justifyContent: 'center', mt: 4 }}>
          <Button
            disabled={page === 1}
            onClick={() => setPage(page - 1)}
          >
            上一页
          </Button>
          <Typography sx={{ mx: 2, display: 'flex', alignItems: 'center' }}>
            {page} / {totalPages}
          </Typography>
          <Button
            disabled={page === totalPages}
            onClick={() => setPage(page + 1)}
          >
            下一页
          </Button>
        </Box>
      )}
    </Container>
  );
};

export default TemplateMarketplace;
