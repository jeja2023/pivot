/// <reference path="../../shims-ui.d.ts" />
/**
 * 模板变量配置表单
 *
 * 功能：
 * - 动态生成表单字段
 * - 实时验证
 * - 类型支持（string, number, select, connection_id, model_id, boolean）
 * - 默认值填充
 */

import React, { FC, FormEvent, useState, useEffect } from 'react';
import {
  Box,
  TextField,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  FormHelperText,
  Checkbox,
  FormControlLabel,
  Button,
  Typography,
  Alert
} from '@mui/material';
import { TemplateVariable } from '../../services/agent/workflowTemplateService';

interface TemplateVariableFormProps {
  variables: TemplateVariable[];
  onSubmit: (values: Record<string, any>) => void | Promise<void>;
  onCancel: () => void;
  loading?: boolean;
}

const TemplateVariableForm: FC<TemplateVariableFormProps> = ({
  variables,
  onSubmit,
  onCancel,
  loading = false
}: TemplateVariableFormProps) => {
  const [values, setValues] = useState<Record<string, any>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState<Record<string, boolean>>({});

  // 初始化默认值
  useEffect(() => {
    const initialValues: Record<string, any> = {};
    variables.forEach((variable: any) => {
      if (variable.default !== undefined) {
        initialValues[variable.name] = variable.default;
      }
    });
    setValues(initialValues);
  }, [variables]);

  // 验证单个字段
  const validateField = (variable: TemplateVariable, value: any): string | null => {
    // 必填验证
    if (variable.required && (value === undefined || value === null || value === '')) {
      return `${variable.label} 是必填项`;
    }

    // 类型验证
    if (value !== undefined && value !== null && value !== '') {
      switch (variable.type) {
        case 'number':
          if (isNaN(Number(value))) {
            return `${variable.label} 必须是数字`;
          }
          break;
      }

      // 范围验证
      if (variable.validation) {
        const { min, max, pattern, message } = variable.validation;

        if (variable.type === 'number') {
          const numValue = Number(value);
          if (min !== undefined && numValue < min) {
            return `${variable.label} 不能小于 ${min}`;
          }
          if (max !== undefined && numValue > max) {
            return `${variable.label} 不能大于 ${max}`;
          }
        } else if (variable.type === 'string') {
          const strValue = String(value);
          if (min !== undefined && strValue.length < min) {
            return `${variable.label} 长度不能小于 ${min}`;
          }
          if (max !== undefined && strValue.length > max) {
            return `${variable.label} 长度不能大于 ${max}`;
          }
          if (pattern && !new RegExp(pattern).test(strValue)) {
            return message || `${variable.label} 格式不正确`;
          }
        }
      }
    }

    return null;
  };

  // 验证所有字段
  const validateAll = (): boolean => {
    const newErrors: Record<string, string> = {};
    let isValid = true;

    variables.forEach((variable: TemplateVariable) => {
      const error = validateField(variable, values[variable.name]);
      if (error) {
        newErrors[variable.name] = error;
        isValid = false;
      }
    });

    setErrors(newErrors);
    return isValid;
  };

  // 处理字段变化
  const handleChange = (name: string, value: any) => {
    setValues((prev: Record<string, any>) => ({ ...prev, [name]: value }));

    // 如果字段已被触碰，立即验证
    if (touched[name]) {
      const variable = variables.find((v: TemplateVariable) => v.name === name);
      if (variable) {
        const error = validateField(variable, value);
        setErrors((prev: Record<string, string>) => ({
          ...prev,
          [name]: error || ''
        }));
      }
    }
  };

  // 处理字段失焦
  const handleBlur = (name: string) => {
    setTouched((prev: Record<string, boolean>) => ({ ...prev, [name]: true }));

    const variable = variables.find((v: TemplateVariable) => v.name === name);
    if (variable) {
      const error = validateField(variable, values[name]);
      setErrors((prev: Record<string, string>) => ({
        ...prev,
        [name]: error || ''
      }));
    }
  };

  // 处理提交
  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();

    // 标记所有字段为已触碰
    const allTouched: Record<string, boolean> = {};
    variables.forEach((v: TemplateVariable) => {
      allTouched[v.name] = true;
    });
    setTouched(allTouched);

    // 验证
    if (!validateAll()) {
      return;
    }

    // 提交
    await onSubmit(values);
  };

  // 渲染字段
  const renderField = (variable: TemplateVariable) => {
    const value = values[variable.name] ?? '';
    const error = touched[variable.name] && errors[variable.name];

    switch (variable.type) {
      case 'string':
        return (
          <TextField
            fullWidth
            label={variable.label}
            value={value}
            onChange={(e: any) => handleChange(variable.name, e.target.value)}
            onBlur={() => handleBlur(variable.name)}
            error={!!error}
            helperText={error || variable.description}
            required={variable.required}
            disabled={loading}
          />
        );

      case 'number':
        return (
          <TextField
            fullWidth
            type="number"
            label={variable.label}
            value={value}
            onChange={(e: any) => handleChange(variable.name, Number(e.target.value))}
            onBlur={() => handleBlur(variable.name)}
            error={!!error}
            helperText={error || variable.description}
            required={variable.required}
            disabled={loading}
            inputProps={{
              min: variable.validation?.min,
              max: variable.validation?.max,
            }}
          />
        );

      case 'select':
        return (
          <FormControl fullWidth error={!!error} required={variable.required}>
            <InputLabel>{variable.label}</InputLabel>
            <Select
              value={value}
              label={variable.label}
              onChange={(e: any) => handleChange(variable.name, e.target.value)}
              onBlur={() => handleBlur(variable.name)}
              disabled={loading}
            >
              {variable.options?.map((option: any) => (
                <MenuItem key={option.value} value={option.value}>
                  {option.label}
                </MenuItem>
              ))}
            </Select>
            <FormHelperText>{error || variable.description}</FormHelperText>
          </FormControl>
        );

      case 'boolean':
        return (
          <FormControlLabel
            control={
              <Checkbox
                checked={!!value}
                onChange={(e: any) => handleChange(variable.name, e.target.checked)}
                disabled={loading}
              />
            }
            label={
              <Box>
                <Typography variant="body2">{variable.label}</Typography>
                {variable.description && (
                  <Typography variant="caption" color="text.secondary">
                    {variable.description}
                  </Typography>
                )}
              </Box>
            }
          />
        );

      case 'connection_id':
        return (
          <FormControl fullWidth error={!!error} required={variable.required}>
            <InputLabel>{variable.label}</InputLabel>
            <Select
              value={value}
              label={variable.label}
              onChange={(e: any) => handleChange(variable.name, e.target.value)}
              onBlur={() => handleBlur(variable.name)}
              disabled={loading}
            >
              {/* TODO: 从 API 加载连接列表 */}
              <MenuItem value={1}>数据库连接 1</MenuItem>
              <MenuItem value={2}>数据库连接 2</MenuItem>
            </Select>
            <FormHelperText>{error || variable.description}</FormHelperText>
          </FormControl>
        );

      case 'model_id':
        return (
          <FormControl fullWidth error={!!error} required={variable.required}>
            <InputLabel>{variable.label}</InputLabel>
            <Select
              value={value}
              label={variable.label}
              onChange={(e: any) => handleChange(variable.name, e.target.value)}
              onBlur={() => handleBlur(variable.name)}
              disabled={loading}
            >
              {/* TODO: 从 API 加载模型列表 */}
              <MenuItem value={1}>GPT-4</MenuItem>
              <MenuItem value={2}>Claude 3.5 Sonnet</MenuItem>
            </Select>
            <FormHelperText>{error || variable.description}</FormHelperText>
          </FormControl>
        );

      default:
        return (
          <Alert severity="warning">
            不支持的字段类型：{variable.type}
          </Alert>
        );
    }
  };

  if (variables.length === 0) {
    return (
      <Box>
        <Alert severity="info" sx={{ mb: 2 }}>
          此模板无需配置变量，可直接应用
        </Alert>
        <Box sx={{ display: 'flex', gap: 2, justifyContent: 'flex-end' }}>
          <Button onClick={onCancel} disabled={loading}>
            取消
          </Button>
          <Button
            variant="contained"
            onClick={handleSubmit}
            disabled={loading}
          >
            {loading ? '创建中...' : '立即创建'}
          </Button>
        </Box>
      </Box>
    );
  }

  return (
    <Box component="form" onSubmit={handleSubmit}>
      <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 2 }}>
        请填写以下变量，然后点击「立即创建」按钮
      </Typography>

      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mb: 3 }}>
        {variables.map((variable: TemplateVariable) => (
          <Box key={variable.name}>
            {renderField(variable)}
          </Box>
        ))}
      </Box>

      <Box sx={{ display: 'flex', gap: 2, justifyContent: 'flex-end' }}>
        <Button onClick={onCancel} disabled={loading}>
          取消
        </Button>
        <Button
          type="submit"
          variant="contained"
          disabled={loading}
        >
          {loading ? '创建中...' : '立即创建'}
        </Button>
      </Box>
    </Box>
  );
};

export default TemplateVariableForm;
