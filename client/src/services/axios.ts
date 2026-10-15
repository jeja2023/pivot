/**
 * 基础 HTTP 客户端 (轻量离线封装)
 */

export interface AxiosResponse<T = any> {
  data: T;
  status: number;
  statusText: string;
  headers: Record<string, string>;
}

export const axios = {
  get: async <T = any>(url: string, config?: { params?: Record<string, any>; headers?: Record<string, string> }): Promise<AxiosResponse<T>> => {
    let targetUrl = url;
    if (config?.params) {
      const searchParams = new URLSearchParams();
      Object.entries(config.params).forEach(([k, v]) => {
        if (v !== undefined && v !== null) {
          searchParams.append(k, String(v));
        }
      });
      const query = searchParams.toString();
      if (query) {
        targetUrl += (targetUrl.includes('?') ? '&' : '?') + query;
      }
    }
    const response = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        ...(config?.headers || {})
      }
    });
    const data = await response.json();
    return {
      data,
      status: response.status,
      statusText: response.statusText,
      headers: {}
    };
  },

  post: async <T = any>(url: string, data?: any, config?: { headers?: Record<string, string> }): Promise<AxiosResponse<T>> => {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...(config?.headers || {})
      },
      body: data !== undefined ? JSON.stringify(data) : undefined
    });
    const responseData = await response.json();
    return {
      data: responseData,
      status: response.status,
      statusText: response.statusText,
      headers: {}
    };
  }
};

export default axios;
