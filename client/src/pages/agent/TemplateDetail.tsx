/// <reference path="../../shims-ui.d.ts" />
/**
 * 工作流模板详情页
 *
 * 功能：
 * - 展示模板完整信息
 * - 预览 DAG 结构
 * - 显示变量定义
 * - 查看评分和评论
 * - 一键应用模板
 */

import React, { FC, Fragment, useState, useEffect } from 'react';
import {
  Box,
  Container,
  Grid,
  Card,
  CardContent,
  Typography,
  Chip,
  Button,
  Rating,
  Divider,
  Tab,
  Tabs,
  Alert,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  CircularProgress,
  Avatar,
  List,
  ListItem,
  ListItemText,
  Paper
} from '@mui/material';
import {
  ArrowBack as ArrowBackIcon,
  PlayArrow as PlayArrowIcon,
  Star as StarIcon,
  Schedule as ScheduleIcon,
  TrendingUp as TrendingUpIcon,
  Description as DescriptionIcon,
  Code as CodeIcon,
  RateReview as RateReviewIcon
} from '@mui/icons-material';
import { useNavigate, useParams } from 'react-router-dom';
import { workflowTemplateService, Template } from '../../services/agent/workflowTemplateService';
import TemplateVariableForm from '../../components/agent/TemplateVariableForm';
import ReactMarkdown from 'react-markdown';

const TemplateDetail: FC = () => {
  const navigate = useNavigate();
  const { slugOrId } = useParams<{ slugOrId: string }>();

  // 状态
  const [template, setTemplate] = useState<Template | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState(0);

  // 应用模板对话框
  const [applyDialogOpen, setApplyDialogOpen] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);

  // 评分对话框
  const [rateDialogOpen, setRateDialogOpen] = useState(false);
  const [rating, setRating] = useState(5);
  const [comment, setComment] = useState('');
  const [submittingRating, setSubmittingRating] = useState(false);

  // 加载模板详情
  useEffect(() => {
    if (slugOrId) {
      loadTemplateDetail();
    }
  }, [slugOrId]);

  const loadTemplateDetail = async () => {
    setLoading(true);
    setError(null);

    try {
      const data = await workflowTemplateService.getTemplateDetail(slugOrId!);
      setTemplate(data);

      // 如果用户已评分，加载评分
      if (data.user_rating) {
        setRating(data.user_rating.rating);
        setComment(data.user_rating.comment || '');
      }
    } catch (err: any) {
      setError(err.message || '加载模板失败');
    } finally {
      setLoading(false);
    }
  };

  const handleApply = async (variables: Record<string, any>) => {
    if (!template) return;

    setApplying(true);
    setApplyError(null);

    try {
      const workflow = await workflowTemplateService.applyTemplate(template.id, variables);
      setApplyDialogOpen(false);

      // 跳转到工作流详情页
      navigate(`/agent/workflows/${workflow.id}`);
    } catch (err: any) {
      setApplyError(err.message || '应用模板失败');
    } finally {
      setApplying(false);
    }
  };

  const handleRate = async () => {
    if (!template) return;

    setSubmittingRating(true);

    try {
      await workflowTemplateService.rateTemplate(template.id, rating, comment);
      setRateDialogOpen(false);

      // 重新加载模板以更新评分
      await loadTemplateDetail();
    } catch (err: any) {
      alert(err.message || '评分失败');
    } finally {
      setSubmittingRating(false);
    }
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

  if (loading) {
    return (
      <Container maxWidth="xl" sx={{ py: 4, display: 'flex', justifyContent: 'center' }}>
        <CircularProgress />
      </Container>
    );
  }

  if (error || !template) {
    return (
      <Container maxWidth="xl" sx={{ py: 4 }}>
        <Alert severity="error">{error || '模板不存在'}</Alert>
      </Container>
    );
  }

  return (
    <Container maxWidth="xl" sx={{ py: 4 }}>
      {/* 顶部导航 */}
      <Box sx={{ mb: 3 }}>
        <Button
          startIcon={<ArrowBackIcon />}
          onClick={() => navigate('/agent/templates')}
        >
          返回模板商城
        </Button>
      </Box>

      <Grid container spacing={3}>
        {/* 左侧：模板信息 */}
        <Grid item xs={12} md={8}>
          {/* 基础信息卡片 */}
          <Card sx={{ mb: 3 }}>
            <CardContent>
              {/* 标题和标签 */}
              <Box sx={{ mb: 2 }}>
                <Typography variant="h4" fontWeight="bold" gutterBottom>
                  {template.name}
                </Typography>
                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mb: 2 }}>
                  <Chip
                    label={getDifficultyLabel(template.difficulty)}
                    size="small"
                    color={getDifficultyColor(template.difficulty)}
                  />
                  <Chip
                    icon={<ScheduleIcon />}
                    label={template.estimated_time}
                    size="small"
                    variant="outlined"
                  />
                  <Chip
                    label={template.category_name}
                    size="small"
                    variant="outlined"
                  />
                  {template.tags.map((tag: string) => (
                    <Chip key={tag} label={tag} size="small" variant="outlined" />
                  ))}
                </Box>
              </Box>

              {/* 统计信息 */}
              <Box sx={{ display: 'flex', gap: 3, mb: 2 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                  <Rating value={template.rating_avg} precision={0.1} size="small" readOnly />
                  <Typography variant="body2" color="text.secondary">
                    {template.rating_avg.toFixed(1)} ({template.rating_count} 人评分)
                  </Typography>
                </Box>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                  <TrendingUpIcon fontSize="small" color="action" />
                  <Typography variant="body2" color="text.secondary">
                    {template.usage_count} 次使用
                  </Typography>
                </Box>
              </Box>

              {/* 描述 */}
              <Typography variant="body1" color="text.secondary">
                {template.description}
              </Typography>

              {/* 作者信息 */}
              {template.author_nickname && (
                <Box sx={{ mt: 2, display: 'flex', alignItems: 'center', gap: 1 }}>
                  <Avatar sx={{ width: 24, height: 24 }}>
                    {template.author_nickname[0]}
                  </Avatar>
                  <Typography variant="caption" color="text.secondary">
                    作者：{template.author_nickname}
                  </Typography>
                  {template.is_builtin && (
                    <Chip label="官方" size="small" color="primary" />
                  )}
                </Box>
              )}
            </CardContent>
          </Card>

          {/* 标签页内容 */}
          <Card>
            <Tabs
              value={activeTab}
              onChange={(_: any, value: any) => setActiveTab(value)}
              sx={{ borderBottom: 1, borderColor: 'divider' }}
            >
              <Tab icon={<DescriptionIcon />} label="文档说明" />
              <Tab icon={<CodeIcon />} label="变量定义" />
              <Tab icon={<RateReviewIcon />} label={`评价 (${template.rating_count})`} />
            </Tabs>

            <CardContent>
              {/* 文档说明 */}
              {activeTab === 0 && (
                <Box>
                  {template.documentation ? (
                    <ReactMarkdown>{template.documentation}</ReactMarkdown>
                  ) : (
                    <Typography color="text.secondary">暂无文档说明</Typography>
                  )}

                  {template.example_output && (
                    <Box sx={{ mt: 3 }}>
                      <Typography variant="h6" gutterBottom>
                        示例输出
                      </Typography>
                      <Paper sx={{ p: 2, bgcolor: 'grey.50' }}>
                        <ReactMarkdown>{template.example_output}</ReactMarkdown>
                      </Paper>
                    </Box>
                  )}
                </Box>
              )}

              {/* 变量定义 */}
              {activeTab === 1 && (
                <Box>
                  {template.variables.length > 0 ? (
                    <List>
                      {template.variables.map((variable: any, index: number) => (
                        <Fragment key={variable.name}>
                          <ListItem alignItems="flex-start">
                            <ListItemText
                              primary={
                                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                  <Typography variant="subtitle1" fontWeight="bold">
                                    {variable.label}
                                  </Typography>
                                  <Chip
                                    label={variable.type}
                                    size="small"
                                    variant="outlined"
                                  />
                                  {variable.required && (
                                    <Chip label="必填" size="small" color="error" />
                                  )}
                                </Box>
                              }
                              secondary={
                                <Box sx={{ mt: 1 }}>
                                  <Typography variant="body2" color="text.secondary">
                                    {variable.description}
                                  </Typography>
                                  {variable.default !== undefined && (
                                    <Typography variant="caption" color="text.secondary">
                                      默认值：{String(variable.default)}
                                    </Typography>
                                  )}
                                  {variable.options && (
                                    <Typography variant="caption" color="text.secondary">
                                      选项：{variable.options.map((opt: any) => opt.label).join('、')}
                                    </Typography>
                                  )}
                                </Box>
                              }
                            />
                          </ListItem>
                          {index < template.variables.length - 1 && <Divider />}
                        </Fragment>
                      ))}
                    </List>
                  ) : (
                    <Typography color="text.secondary">此模板无需配置变量</Typography>
                  )}
                </Box>
              )}

              {/* 评价列表 */}
              {activeTab === 2 && (
                <Box>
                  <Typography color="text.secondary">
                    评价功能即将上线，敬请期待
                  </Typography>
                  {/* TODO: 实现评价列表 */}
                </Box>
              )}
            </CardContent>
          </Card>
        </Grid>

        {/* 右侧：操作面板 */}
        <Grid item xs={12} md={4}>
          <Card sx={{ position: 'sticky', top: 80 }}>
            <CardContent>
              <Button
                fullWidth
                variant="contained"
                size="large"
                startIcon={<PlayArrowIcon />}
                onClick={() => setApplyDialogOpen(true)}
                sx={{ mb: 2 }}
              >
                立即使用
              </Button>

              <Button
                fullWidth
                variant="outlined"
                startIcon={<StarIcon />}
                onClick={() => setRateDialogOpen(true)}
              >
                {template.user_rating ? '修改评分' : '评分'}
              </Button>

              <Divider sx={{ my: 2 }} />

              {/* 统计信息 */}
              <Box>
                <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                  模板信息
                </Typography>
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                  <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                    <Typography variant="body2">分类</Typography>
                    <Typography variant="body2" fontWeight="medium">
                      {template.category_name}
                    </Typography>
                  </Box>
                  <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                    <Typography variant="body2">难度</Typography>
                    <Typography variant="body2" fontWeight="medium">
                      {getDifficultyLabel(template.difficulty)}
                    </Typography>
                  </Box>
                  <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                    <Typography variant="body2">预估时间</Typography>
                    <Typography variant="body2" fontWeight="medium">
                      {template.estimated_time}
                    </Typography>
                  </Box>
                  <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                    <Typography variant="body2">使用次数</Typography>
                    <Typography variant="body2" fontWeight="medium">
                      {template.usage_count}
                    </Typography>
                  </Box>
                  <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                    <Typography variant="body2">平均评分</Typography>
                    <Typography variant="body2" fontWeight="medium">
                      {template.rating_avg.toFixed(1)} / 5.0
                    </Typography>
                  </Box>
                </Box>
              </Box>
            </CardContent>
          </Card>
        </Grid>
      </Grid>

      {/* 应用模板对话框 */}
      <Dialog
        open={applyDialogOpen}
        onClose={() => !applying && setApplyDialogOpen(false)}
        maxWidth="md"
        fullWidth
      >
        <DialogTitle>应用模板：{template.name}</DialogTitle>
        <DialogContent>
          {applyError && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {applyError}
            </Alert>
          )}
          <TemplateVariableForm
            variables={template.variables}
            onSubmit={handleApply}
            onCancel={() => setApplyDialogOpen(false)}
            loading={applying}
          />
        </DialogContent>
      </Dialog>

      {/* 评分对话框 */}
      <Dialog
        open={rateDialogOpen}
        onClose={() => !submittingRating && setRateDialogOpen(false)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>评分模板</DialogTitle>
        <DialogContent>
          <Box sx={{ py: 2 }}>
            <Typography variant="subtitle2" gutterBottom>
              评分
            </Typography>
            <Rating
              value={rating}
              onChange={(_: any, value: any) => setRating(value || 5)}
              size="large"
            />

            <Typography variant="subtitle2" sx={{ mt: 3, mb: 1 }}>
              评论（可选）
            </Typography>
            <textarea
              value={comment}
              onChange={(e: any) => setComment(e.target.value)}
              placeholder="分享您的使用体验..."
              rows={4}
              style={{
                width: '100%',
                padding: '8px',
                fontFamily: 'inherit',
                fontSize: '14px',
                border: '1px solid #ddd',
                borderRadius: '4px',
              }}
            />
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRateDialogOpen(false)} disabled={submittingRating}>
            取消
          </Button>
          <Button
            onClick={handleRate}
            variant="contained"
            disabled={submittingRating}
          >
            {submittingRating ? '提交中...' : '提交评分'}
          </Button>
        </DialogActions>
      </Dialog>
    </Container>
  );
};

export default TemplateDetail;
