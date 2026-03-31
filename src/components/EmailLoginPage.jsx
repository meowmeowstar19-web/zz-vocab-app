import { useState } from 'react';

export default function EmailLoginPage({ onBack, onLogin }) {
  const [mode, setMode] = useState('login'); // 'login' or 'signup'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (!email || !password) {
      setError('请填写邮箱和密码');
      return;
    }

    if (mode === 'signup' && password !== confirmPassword) {
      setError('两次输入的密码不一致');
      return;
    }

    setLoading(true);
    try {
      // TODO: Replace with Supabase auth
      // if (mode === 'signup') {
      //   const { error } = await supabase.auth.signUp({ email, password });
      //   if (error) throw error;
      // } else {
      //   const { error } = await supabase.auth.signInWithPassword({ email, password });
      //   if (error) throw error;
      // }
      // onLogin();

      // Temporary: just log in directly
      onLogin();
    } catch (err) {
      setError(err.message || '登录失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative w-full h-full overflow-hidden">
      {/* Background */}
      <img
        src="/assets/figma/login-bg.jpg"
        alt=""
        className="absolute inset-0 w-full h-full object-cover pointer-events-none"
      />

      {/* Back button */}
      <button
        onClick={onBack}
        className="absolute top-[40px] left-[20px] z-10 w-[36px] h-[36px] rounded-full bg-white/70 flex items-center justify-center active:scale-95 transition-transform"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#333" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M15 18l-6-6 6-6" />
        </svg>
      </button>

      {/* Form */}
      <form onSubmit={handleSubmit} className="absolute left-0 right-0 top-[111px] px-[29px]">
        {/* Email */}
        <label className="block text-[16px] text-black mb-1">邮箱地址：</label>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-[329px] h-[50px] rounded-[25px] border-2 border-black bg-white px-5 text-[15px] outline-none focus:border-[#ffd016] transition-colors"
          placeholder="your@email.com"
        />

        {/* Password */}
        <label className="block text-[16px] text-black mb-1 mt-[20px]">密码:</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-[329px] h-[50px] rounded-[25px] border-2 border-black bg-white px-5 text-[15px] outline-none focus:border-[#ffd016] transition-colors"
          placeholder="••••••••"
        />

        {/* Confirm Password (signup only) */}
        {mode === 'signup' && (
          <>
            <label className="block text-[16px] text-black mb-1 mt-[20px]">确认密码：</label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="w-[329px] h-[50px] rounded-[25px] border-2 border-black bg-white px-5 text-[15px] outline-none focus:border-[#ffd016] transition-colors"
              placeholder="••••••••"
            />
          </>
        )}

        {/* Error message */}
        {error && (
          <p className="text-red-500 text-[13px] mt-3 text-center">{error}</p>
        )}

        {/* Submit button */}
        <div className="flex justify-center mt-[30px]">
          <button
            type="submit"
            disabled={loading}
            className="w-[128px] h-[48px] rounded-[100px] bg-[#ffd016] border-2 border-black text-[20px] text-black font-normal active:scale-95 transition-transform disabled:opacity-50"
          >
            {loading ? '...' : (mode === 'signup' ? '注册' : '登录')}
          </button>
        </div>

        {/* Toggle login/signup */}
        <p className="text-center mt-[20px] text-[14px] text-black/60">
          {mode === 'login' ? (
            <>还没有账号？<button type="button" onClick={() => { setMode('signup'); setError(''); }} className="text-black underline">注册</button></>
          ) : (
            <>已有账号？<button type="button" onClick={() => { setMode('login'); setError(''); }} className="text-black underline">登录</button></>
          )}
        </p>
      </form>
    </div>
  );
}
