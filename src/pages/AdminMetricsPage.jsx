import {
  Activity,
  AlertCircle,
  ArrowDownRight,
  BarChart3,
  CheckCircle2,
  Clock3,
  FileWarning,
  Gauge,
  RefreshCcw,
  Repeat2,
  Search,
  TrendingDown,
  Users,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import LoadingButton from "../components/LoadingButton.jsx";
import Metric from "../components/Metric.jsx";
import { api } from "../services/api.js";

const tabs = [
  { id: "overview", label: "全局概览", icon: BarChart3 },
  { id: "diagnosis", label: "流失诊断", icon: TrendingDown },
  { id: "experience", label: "核心体验", icon: Gauge },
  { id: "retention", label: "用户留存", icon: Users },
];

const eventLabels = {
  register_succeeded: "注册成功",
  login_succeeded: "登录成功",
  upload_clicked: "点击上传",
  upload_succeeded: "上传成功",
  upload_failed: "上传失败",
  practice_started: "开始练习",
  answer_submitted: "提交答案",
  practice_finished: "完成练习",
  mistakes_viewed: "查看错题本",
  mistake_retry_started: "错题重做",
  bottom_nav_mistakes_clicked: "底部错题入口",
  bottom_nav_history_clicked: "底部历史科目入口",
  summary_mistakes_clicked: "总结页错题入口",
  summary_mistakes_cta_viewed: "总结页错题引导曝光",
  home_mistakes_clicked: "首页错题入口",
  subject_mistakes_clicked: "科目页错题入口",
};

function number(value) {
  return Number(value || 0);
}

function percent(part, whole) {
  if (!number(whole)) return 0;
  return Math.round((number(part) / number(whole)) * 100);
}

function formatPercent(part, whole) {
  return `${percent(part, whole)}%`;
}

function eventLabel(name) {
  return eventLabels[name] || name;
}

function formatTime(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function buildFunnelSteps(metrics) {
  const source = metrics?.userFunnel || [];
  const registered = number(metrics?.dataTrust?.realRegisteredUsers ?? source[0]?.value ?? metrics?.totals?.users);
  const uploaded = number(source[1]?.value ?? metrics?.behaviorVolume?.uploads);
  const started = number(source[2]?.value ?? metrics?.behaviorVolume?.practiceStarted);
  const completed = number(source[3]?.value ?? metrics?.behaviorVolume?.practiceCompleted);
  const mistakeViews = number(metrics?.behaviorVolume?.mistakeViews);
  const retry = number(metrics?.behaviorVolume?.mistakeRetries);

  const steps = [
    {
      id: "auth",
      name: "注册/登录",
      value: registered,
      event: "signup_complete / login_complete",
      page: "首页",
      diagnosis: "如果这里偏低，优先检查首页价值表达和注册流程阻力。",
    },
    {
      id: "upload",
      name: "上传建科目",
      value: uploaded,
      event: "subject_created",
      page: "上传页",
      diagnosis: "这里掉人通常意味着不知道传什么、资料格式卡住，或建库耗时太长。",
    },
    {
      id: "practice",
      name: "开始练习",
      value: started,
      event: "practice_started",
      page: "练习设置页",
      diagnosis: "这里掉人多半是设置项犹豫、题型选择不确定，或建完库后动力断了。",
    },
    {
      id: "complete",
      name: "完成答题",
      value: completed,
      event: "practice_completed",
      page: "答题页",
      diagnosis: "这里是核心体验断点，重点看题量、AI 速度、题目质量和语音体验。",
    },
    {
      id: "wrong-book",
      name: "查看错题本",
      value: mistakeViews,
      event: "mistakes_viewed",
      page: "总结页/错题本",
      diagnosis: "做完不看错题，说明总结页入口、错题价值或正反馈还不够强。",
    },
    {
      id: "retry",
      name: "错题重做",
      value: retry,
      event: "retry_started",
      page: "错题本页",
      diagnosis: "重做率低说明训练闭环没有形成，需要强化进步反馈和重做入口。",
    },
  ];

  return steps.map((step, index) => {
    const previous = index === 0 ? step.value : steps[index - 1].value;
    const conversionRate = index === 0 ? 100 : percent(step.value, previous);
    return {
      ...step,
      conversionRate,
      dropoffRate: index === 0 ? 0 : 100 - conversionRate,
      previous,
    };
  });
}

function buildDiagnostics(metrics, funnelSteps) {
  const uploadClicks = number(metrics?.behaviorVolume?.uploadClicks);
  const uploadSuccess = number(metrics?.behaviorVolume?.uploadSuccessEvents);
  const uploadFailures = number(metrics?.behaviorVolume?.uploadFailures);
  const completionRate = number(metrics?.practice?.completionRate);
  const averageAccuracy = number(metrics?.practice?.averageAccuracy);
  const retryRate = percent(metrics?.behaviorVolume?.mistakeRetries, metrics?.behaviorVolume?.practiceCompleted);
  const eventNames = new Set((metrics?.eventBreakdown || []).map((item) => item.name));

  const cards = [];
  const uploadStep = funnelSteps.find((step) => step.id === "upload");
  const practiceStep = funnelSteps.find((step) => step.id === "practice");
  const completeStep = funnelSteps.find((step) => step.id === "complete");
  const retryStep = funnelSteps.find((step) => step.id === "retry");

  cards.push({
    title: "注册后未上传",
    level: uploadStep?.conversionRate < 60 ? "high" : "normal",
    metric: `${uploadStep?.conversionRate || 0}%`,
    detail: "从注册/登录到上传建科目的转化。",
    action: "检查上传页是否说清楚“传什么资料”、格式限制和建库等待反馈。",
  });
  cards.push({
    title: "建库后未开练",
    level: practiceStep?.conversionRate < 70 ? "high" : "normal",
    metric: `${practiceStep?.conversionRate || 0}%`,
    detail: "从上传建科目到开始练习的转化。",
    action: "减少默认题型决策成本，提供一键开始的默认练习。",
  });
  cards.push({
    title: "练习中途流失",
    level: completionRate < 65 ? "high" : "normal",
    metric: `${completionRate}%`,
    detail: "开始练习后完成整轮的比例。",
    action: "优先追踪放弃题号、AI 出题/批改耗时和主观题语音编辑率。",
  });
  cards.push({
    title: "错题闭环不足",
    level: retryRate < 25 ? "high" : "normal",
    metric: `${retryRate}%`,
    detail: "完成练习后触发错题重做的比例。",
    action: "在总结页突出“上次 X% → 本次 Y%”的进步反馈。",
  });

  if (uploadClicks || uploadSuccess || uploadFailures) {
    cards.push({
      title: "上传链路健康度",
      level: uploadFailures > uploadSuccess * 0.25 ? "high" : "normal",
      metric: uploadClicks ? formatPercent(uploadSuccess, uploadClicks) : `${uploadFailures} 次失败`,
      detail: "上传尝试到上传成功的表现。",
      action: "把失败原因按格式、大小、扫描版 PDF、解析失败拆开看。",
    });
  }

  cards.push({
    title: "题目难度窗口",
    level: averageAccuracy && (averageAccuracy < 40 || averageAccuracy > 75) ? "medium" : "normal",
    metric: averageAccuracy ? `${averageAccuracy}%` : "暂无",
    detail: "平均正确率过低可能超纲，过高可能太简单。",
    action: "把客观题首次正确率和主观题准确率分开监控。",
  });

  if (!eventNames.has("page_view") && !eventNames.has("page_view_home")) {
    cards.push({
      title: "首屏流失数据缺口",
      level: "medium",
      metric: "待埋点",
      detail: "当前还看不到“访问首页但未注册”的真实流失。",
      action: "补 `page_view`、`page_leave`、`signup_attempt`，才能定位首屏价值表达问题。",
    });
  }

  return cards;
}

function BarList({ items, valueKey = "value", labelKey = "name", emptyText = "暂无数据" }) {
  const max = Math.max(1, ...items.map((item) => number(item[valueKey])));
  if (!items.length) return <p className="metrics-empty">{emptyText}</p>;

  return (
    <div className="metrics-bars">
      {items.map((item) => {
        const value = number(item[valueKey]);
        return (
          <div className="metrics-bar-row" key={`${item[labelKey]}-${value}`}>
            <div className="metrics-bar-label">
              <span>{labelKey === "name" ? eventLabel(item[labelKey]) : item[labelKey]}</span>
              <strong>{value}</strong>
            </div>
            <div className="metrics-bar-track">
              <span style={{ width: `${Math.max(4, Math.round((value / max) * 100))}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function FunnelView({ steps }) {
  const max = Math.max(1, ...steps.map((step) => step.value));
  const worstDropoff = steps.slice(1).reduce((worst, step) => (step.dropoffRate > worst.dropoffRate ? step : worst), steps[1] || steps[0]);

  return (
    <section className="metrics-card dashboard-funnel-card">
      <div className="metrics-card-head">
        <div>
          <h2>
            <TrendingDown size={20} />
            6 步核心转化漏斗
          </h2>
          <p>从“注册/登录”到“错题重做”，直接看哪一步掉人最多。当前最大断点：{worstDropoff?.name || "暂无"}。</p>
        </div>
      </div>
      <div className="funnel-pipeline">
        {steps.map((step, index) => (
          <article className={`funnel-step ${step.dropoffRate >= 50 ? "is-risk" : ""}`} key={step.id}>
            <div className="funnel-step-head">
              <span>Step {index + 1}</span>
              <strong>{step.name}</strong>
            </div>
            <div className="funnel-step-bar">
              <span style={{ width: `${Math.max(8, Math.round((step.value / max) * 100))}%` }} />
            </div>
            <div className="funnel-step-meta">
              <strong>{step.value}</strong>
              <span>{index === 0 ? "基准" : `转化 ${step.conversionRate}% / 流失 ${step.dropoffRate}%`}</span>
            </div>
            <small>{step.event}</small>
          </article>
        ))}
      </div>
    </section>
  );
}

function DiagnosticList({ diagnostics }) {
  return (
    <section className="metrics-card">
      <div className="metrics-card-head">
        <div>
          <h2>
            <Search size={20} />
            流失问题定位
          </h2>
          <p>每张诊断都对应一个产品假设，方便你下一轮内测优先验证。</p>
        </div>
      </div>
      <div className="diagnosis-list">
        {diagnostics.map((item) => (
          <article className={`diagnosis-row diagnosis-${item.level}`} key={item.title}>
            <div>
              <span>{item.level === "high" ? "高优先级" : item.level === "medium" ? "需补数据" : "观察中"}</span>
              <h3>{item.title}</h3>
              <p>{item.detail}</p>
            </div>
            <strong>{item.metric}</strong>
            <p>{item.action}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function DailyActivity({ dailyActivity = [] }) {
  const topDailyValue = Math.max(1, ...dailyActivity.map((item) => Math.max(number(item.events), number(item.answers), number(item.activeUsers))));

  return (
    <section className="metrics-card">
      <div className="metrics-card-head">
        <h2>
          <Activity size={20} />
          最近 7 天趋势
        </h2>
      </div>
      <div className="metrics-daily">
        {dailyActivity.map((item) => (
          <div className="metrics-day" key={item.date}>
            <div className="metrics-day-bars">
              <span className="events" style={{ height: `${Math.max(6, (number(item.events) / topDailyValue) * 100)}%` }} />
              <span className="answers" style={{ height: `${Math.max(6, (number(item.answers) / topDailyValue) * 100)}%` }} />
              <span className="users" style={{ height: `${Math.max(6, (number(item.activeUsers) / topDailyValue) * 100)}%` }} />
            </div>
            <small>{item.date}</small>
          </div>
        ))}
      </div>
      <div className="metrics-legend">
        <span>
          <Activity size={14} />
          事件
        </span>
        <span>
          <CheckCircle2 size={14} />
          答题
        </span>
        <span>
          <Users size={14} />
          活跃用户
        </span>
      </div>
    </section>
  );
}

function EventTable({ events }) {
  if (!events.length) return <p className="metrics-empty">暂无埋点事件</p>;

  return (
    <div className="events-table">
      {events.map((event) => (
        <article className="event-row" key={event.id}>
          <div>
            <strong>{eventLabel(event.eventName)}</strong>
            <span>{event.user?.nickname || event.user?.email || "匿名用户"}</span>
          </div>
          <div>
            <span>{event.pagePath || "-"}</span>
            <time>{formatTime(event.createdAt)}</time>
          </div>
        </article>
      ))}
    </div>
  );
}

function DataGapList() {
  const gaps = [
    ["首页访问流失", "`page_view`、`page_leave`、`signup_attempt`"],
    ["AI 出题/批改速度", "`question_generated.generation_duration_seconds`、批改耗时"],
    ["语音体验", "`voice_input.edit_after_asr`、`voice_edit.edit_distance`"],
    ["题目质量反馈", "`question_feedback.feedback_type`"],
  ];

  return (
    <div className="data-gap-list">
      {gaps.map(([title, fields]) => (
        <div key={title}>
          <strong>{title}</strong>
          <span>{fields}</span>
        </div>
      ))}
    </div>
  );
}

export default function AdminMetricsPage() {
  const [activeTab, setActiveTab] = useState("overview");
  const [metrics, setMetrics] = useState(null);
  const [events, setEvents] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    setError("");
    try {
      const [nextMetrics, nextEvents] = await Promise.all([api.getAdminMetrics(), api.getAdminEvents(50)]);
      setMetrics(nextMetrics);
      setEvents(nextEvents);
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const funnelSteps = useMemo(() => buildFunnelSteps(metrics), [metrics]);
  const diagnostics = useMemo(() => buildDiagnostics(metrics, funnelSteps), [metrics, funnelSteps]);
  const biggestDropoff = funnelSteps.slice(1).reduce((worst, step) => (step.dropoffRate > worst.dropoffRate ? step : worst), funnelSteps[1] || funnelSteps[0]);
  const retryRate = percent(metrics?.behaviorVolume?.mistakeRetries, metrics?.behaviorVolume?.practiceCompleted);
  const uploadSuccessRate = percent(
    metrics?.behaviorVolume?.uploadSuccessEvents || metrics?.behaviorVolume?.uploads,
    metrics?.behaviorVolume?.uploadClicks || metrics?.behaviorVolume?.uploadSuccessEvents || metrics?.behaviorVolume?.uploads,
  );

  if (!metrics && loading) return <div className="skeleton-page" />;

  return (
    <div className="stack metrics-page metrics-dashboard">
      <section className="page-title metrics-title dashboard-hero">
        <div>
          <p className="eyebrow muted">期末刷内测数据看板</p>
          <h1>定位用户流失，验证训练闭环</h1>
          <p>围绕“上传资料 → AI 出题 → 答题批改 → 错题重做”的主链路搭建，优先帮你发现用户卡在哪一步。</p>
        </div>
        <LoadingButton className="secondary-button" loading={loading} onClick={load}>
          <RefreshCcw size={17} />
          刷新
        </LoadingButton>
      </section>

      {error && (
        <div className="notice error">
          <AlertCircle size={17} />
          {error}
        </div>
      )}

      {metrics && (
        <>
          <nav className="dashboard-tabs" aria-label="数据看板分类">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              return (
                <button className={activeTab === tab.id ? "active" : ""} type="button" onClick={() => setActiveTab(tab.id)} key={tab.id}>
                  <Icon size={17} />
                  {tab.label}
                </button>
              );
            })}
          </nav>

          {activeTab === "overview" && (
            <>
              <section className="metrics-grid dashboard-kpis">
                <Metric label="真实注册用户" value={metrics.dataTrust?.realRegisteredUsers ?? metrics.totals.users} tone="good" />
                <Metric label="今日活跃用户" value={metrics.today.activeUsers} />
                <Metric label="最大流失断点" value={biggestDropoff?.name || "-"} tone={biggestDropoff?.dropoffRate >= 50 ? "warn" : "neutral"} />
                <Metric label="整轮完练率" value={`${metrics.practice.completionRate}%`} tone={metrics.practice.completionRate >= 65 ? "good" : "warn"} />
                <Metric label="错题重做率" value={`${retryRate}%`} tone={retryRate >= 25 ? "good" : "warn"} />
                <Metric label="平均正确率" value={`${metrics.practice.averageAccuracy}%`} />
                <Metric label="上传成功率" value={uploadSuccessRate ? `${uploadSuccessRate}%` : "暂无"} tone={uploadSuccessRate >= 80 ? "good" : "warn"} />
                <Metric label="今日事件数" value={metrics.today.events} />
              </section>

              <FunnelView steps={funnelSteps} />

              <section className="metrics-split">
                <DailyActivity dailyActivity={metrics.dailyActivity || []} />
                <section className="metrics-card">
                  <div className="metrics-card-head">
                    <h2>
                      <Activity size={20} />
                      最近 7 天事件
                    </h2>
                  </div>
                  <BarList items={(metrics.eventBreakdown || []).map((item) => ({ name: item.name, value: item.count }))} emptyText="暂无事件数据" />
                </section>
              </section>
            </>
          )}

          {activeTab === "diagnosis" && (
            <>
              <DiagnosticList diagnostics={diagnostics} />

              <section className="metrics-split">
                <section className="metrics-card">
                  <div className="metrics-card-head">
                    <div>
                      <h2>
                        <ArrowDownRight size={20} />
                        分步流失率
                      </h2>
                      <p>流失率越高，越应该优先看该步骤的用户录屏和埋点明细。</p>
                    </div>
                  </div>
                  <BarList items={funnelSteps.slice(1).map((step) => ({ name: step.name, value: step.dropoffRate }))} emptyText="暂无漏斗数据" />
                </section>

                <section className="metrics-card">
                  <div className="metrics-card-head">
                    <div>
                      <h2>
                        <FileWarning size={20} />
                        上传与错题入口
                      </h2>
                      <p>这两处分别影响“能否进入核心体验”和“能否形成复习闭环”。</p>
                    </div>
                  </div>
                  <div className="metrics-grid compact">
                    <Metric label="上传点击" value={metrics.behaviorVolume?.uploadClicks || 0} />
                    <Metric label="上传成功事件" value={metrics.behaviorVolume?.uploadSuccessEvents || 0} tone="good" />
                    <Metric label="上传失败事件" value={metrics.behaviorVolume?.uploadFailures || 0} tone={metrics.behaviorVolume?.uploadFailures ? "warn" : "good"} />
                    <Metric label="错题入口点击" value={metrics.behaviorVolume?.mistakeEntryClicks || 0} />
                    <Metric label="错题重做" value={metrics.behaviorVolume?.mistakeRetries || 0} />
                  </div>
                </section>
              </section>

              <section className="metrics-card">
                <div className="metrics-card-head">
                  <div>
                    <h2>
                      <Clock3 size={20} />
                      最新用户行为
                    </h2>
                    <p>内测阶段可以逐条看用户路径，快速还原“在哪一步犹豫或离开”。</p>
                  </div>
                </div>
                <EventTable events={events} />
              </section>
            </>
          )}

          {activeTab === "experience" && (
            <>
              <section className="metrics-grid dashboard-kpis">
                <Metric label="累计练习次数" value={metrics.behaviorVolume?.practiceStarted || 0} />
                <Metric label="累计完成次数" value={metrics.behaviorVolume?.practiceCompleted || 0} tone="good" />
                <Metric label="累计答题数" value={metrics.behaviorVolume?.answers || 0} />
                <Metric label="错题数" value={metrics.behaviorVolume?.mistakes || metrics.totals.mistakes} tone={metrics.totals.mistakes ? "warn" : "good"} />
                <Metric label="平均正确率" value={`${metrics.practice.averageAccuracy}%`} />
                <Metric label="错误答案率" value={`${metrics.practice.wrongAnswerRate || 0}%`} />
                <Metric label="AI 速度 P95" value="待埋点" />
                <Metric label="ASR 编辑率" value="待埋点" />
              </section>

              <section className="metrics-card">
                <div className="metrics-card-head">
                  <div>
                    <h2>
                      <Gauge size={20} />
                      核心体验判断
                    </h2>
                    <p>期末刷的关键不是“用了没有”，而是用户是否愿意完成一轮、相信批改、回来重做错题。</p>
                  </div>
                </div>
                <div className="experience-grid">
                  <div>
                    <strong>完练率</strong>
                    <span>{metrics.practice.completionRate}%</span>
                    <p>{metrics.practice.completionRate >= 65 ? "核心答题体验暂时健康。" : "低于 65%，优先排查题量、等待时间和中途放弃题号。"}</p>
                  </div>
                  <div>
                    <strong>正确率</strong>
                    <span>{metrics.practice.averageAccuracy}%</span>
                    <p>{metrics.practice.averageAccuracy < 40 ? "可能题目过难或超出资料范围。" : metrics.practice.averageAccuracy > 75 ? "可能题目偏简单，训练压力不足。" : "难度落在较合理区间。"}</p>
                  </div>
                  <div>
                    <strong>错题闭环</strong>
                    <span>{retryRate}%</span>
                    <p>{retryRate >= 25 ? "已有一定闭环迹象。" : "错题重做偏低，需要强化总结页入口和进步反馈。"}</p>
                  </div>
                </div>
              </section>

              <section className="metrics-card">
                <div className="metrics-card-head">
                  <div>
                    <h2>
                      <FileWarning size={20} />
                      下一批必须补的体验埋点
                    </h2>
                    <p>这些数据一补上，就能把“感觉不好用”拆成可定位的问题。</p>
                  </div>
                </div>
                <DataGapList />
              </section>
            </>
          )}

          {activeTab === "retention" && (
            <>
              <section className="metrics-grid dashboard-kpis">
                <Metric label="今日新增" value={metrics.today.registeredUsers} />
                <Metric label="今日活跃" value={metrics.today.activeUsers} />
                <Metric label="累计激活用户" value={funnelSteps.find((step) => step.id === "complete")?.value || 0} tone="good" />
                <Metric label="错题回访信号" value={metrics.behaviorVolume?.mistakeViews || 0} />
              </section>

              <section className="metrics-split">
                <DailyActivity dailyActivity={metrics.dailyActivity || []} />
                <section className="metrics-card">
                  <div className="metrics-card-head">
                    <div>
                      <h2>
                        <Repeat2 size={20} />
                        留存读法
                      </h2>
                      <p>内测早期先看“次日是否回来练”和“做完后是否重做错题”。</p>
                    </div>
                  </div>
                  <div className="retention-notes">
                    <p>
                      <strong>D1 留存目标：</strong>注册次日回来练习，建议目标 &gt; 30%。
                    </p>
                    <p>
                      <strong>D3 留存目标：</strong>形成短期复习习惯，建议目标 &gt; 15%。
                    </p>
                    <p>
                      <strong>D7 留存目标：</strong>度过新鲜期，建议目标 &gt; 10%。
                    </p>
                    <p>
                      当前接口已有 7 天活跃趋势，但还没有完整 cohort 表。建议后端下一步按注册日输出 D1/D3/D7。
                    </p>
                  </div>
                </section>
              </section>
            </>
          )}
        </>
      )}
    </div>
  );
}
