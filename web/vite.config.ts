import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { visualizer } from 'rollup-plugin-visualizer'
import UnoCSS from 'unocss/vite'
import { defineConfig } from 'vite'
import viteCompression from 'vite-plugin-compression'

function readJson(file: string, fallback: any): any {
  try {
    return JSON.parse(readFileSync(file, 'utf-8'))
  }
  catch {
    return fallback
  }
}

const corePackageJson = readJson(fileURLToPath(new URL('../core/package.json', import.meta.url)), { version: '0.0.0' })
// 版本号单一真源：仓库根 version.json（由 scripts/version.mjs 在每次更新提交后递增）。
// 容器构建只 COPY web/ 时根文件不在上下文里，用脚本同步的 web/version.json 镜像兜底。
const rootVersionMeta = readJson(fileURLToPath(new URL('../version.json', import.meta.url)), null)
const webVersionMeta = readJson(fileURLToPath(new URL('./version.json', import.meta.url)), null)
const versionMeta = rootVersionMeta?.version ? rootVersionMeta : (webVersionMeta?.version ? webVersionMeta : null)
const appVersion = String(versionMeta?.version || corePackageJson.version || '0.0.0')
const appBuild = Number(versionMeta?.build)
const hasBuild = Number.isFinite(appBuild) && appBuild > 0
// 完全读不到版本文件时只显示版本号，避免把更新次数回退成 0。
const appVersionLabel = hasBuild ? `v${appVersion} · 第 ${appBuild} 次更新` : `v${appVersion}`

// 构建指纹：版本号 + 构建序号 + 构建时刻。在线更新完成后后端会把它广播给浏览器，
// 前端拿自己 bundle 里烘焙的这份指纹一比，就知道标签页里跑的是不是刷新前的旧代码。
const builtAt = Date.now()
const appBuildId = `${appVersion}-${hasBuild ? appBuild : '0'}-${builtAt}`

/**
 * 把构建信息写到 `dist/version.json`。
 *
 * 后端只读这个文件就知道「现在服务器上摆着的前端是哪个版本」，不需要去解析 bundle。
 * 回滚时旧快照里自带它，所以回滚后前端版本号也会跟着退回去。
 */
function buildInfoFilePlugin() {
  return {
    name: 'qq-farm-build-info',
    apply: 'build' as const,
    writeBundle(options: any, bundle: Record<string, any>) {
      void bundle
      const outDir = options?.dir || fileURLToPath(new URL('./dist', import.meta.url))
      writeFileSync(
        `${outDir}/version.json`,
        `${JSON.stringify({ buildId: appBuildId, appVersion, appBuild: hasBuild ? appBuild : 0, builtAt }, null, 2)}\n`,
        'utf8',
      )
    },
  }
}

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const analyzeBuild = mode === 'analyze'
  const compressedBuild = mode === 'compressed'

  return {
    plugins: [
      UnoCSS() as any,
      vue(),
      buildInfoFilePlugin() as any,
      ...(compressedBuild
        ? [viteCompression({
            verbose: true,
            threshold: 10240,
            algorithm: 'gzip',
            ext: '.gz',
          })]
        : []),
      ...(analyzeBuild
        ? [visualizer({
            open: false,
            gzipSize: true,
            brotliSize: true,
          })]
        : []),
    ],
    build: {
      // Compressed-size reporting and bundle analysis are useful on demand,
      // but add avoidable CPU work to every Linux/Docker startup build.
      reportCompressedSize: analyzeBuild,
      rollupOptions: {
        output: {
          manualChunks(id) {
            const normalizedId = id.replace(/\\/g, '/')
            if (!normalizedId.includes('/node_modules/'))
              return undefined

            const matchesPackage = (name: string) => normalizedId.includes(`/node_modules/${name}/`)

            if (['vue', 'vue-router', 'pinia', '@vueuse/core'].some(matchesPackage))
              return 'vendor-vue'

            if ([
              'naive-ui',
              'vueuc',
              'vdirs',
              'vooks',
              'css-render',
              '@css-render/vue3-ssr',
              '@css-render/plugin-bem',
              'seemly',
              'treemate',
              'evtd',
              'date-fns',
              'date-fns-tz',
              'lodash-es',
              'async-validator',
            ].some(matchesPackage)) {
              return 'vendor-ui'
            }

            if (matchesPackage('axios'))
              return 'vendor-axios'

            return 'vendor'
          },
        },
      },
      chunkSizeWarningLimit: 1000,
    },
    define: {
      __APP_VERSION__: JSON.stringify(appVersion),
      __APP_BUILD__: JSON.stringify(hasBuild ? String(appBuild) : ''),
      __APP_VERSION_LABEL__: JSON.stringify(appVersionLabel),
      __APP_BUILD_ID__: JSON.stringify(appBuildId),
    },
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    server: {
      proxy: {
        '/socket.io': {
          target: 'http://localhost:3007',
          changeOrigin: true,
          ws: true,
        },
        '/api': {
          target: 'http://localhost:3007',
          changeOrigin: true,
        },
        '/game-config': {
          target: 'http://localhost:3007',
          changeOrigin: true,
        },
      },
    },
  }
})
