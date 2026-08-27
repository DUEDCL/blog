---
title: 二分查找的边界，我每次都要重推一遍
description: 写了这么多年还是记不住 mid 该怎么取、循环条件用小于还是小于等于。索引不如理解不变量。
pubDate: 2026-08-10
tags: ['算法', '笔记']
# 元数据的译文（R46）。正文仍是中文原文，详情页会在标题下挂一条说明 ——
# 正文也译好之后放到 src/content/i18n/<语言>/<栏目>/ 下，那时这一段可以留着，
# 两处都有时以译文文件里的为准（见 content.config.ts 的注释）。
i18n:
  en:
    title: "The boundaries in binary search — I re-derive them every single time"
    description: "After all these years I still cannot remember how to take mid, or whether the loop condition is < or <=. Memorising the template loses to holding on to one invariant."
  ja:
    title: "二分探索の境界、毎回いちから導き直している"
    description: "何年書いても mid の取り方も、ループ条件が < か <= かも覚えられない。テンプレを覚えるより、不変条件をひとつ握るほうが効く。"
---

每次写二分查找我都要停下来想几秒。不是不会，是记不住那几个边界该怎么取。后来发现问题在于我一直试图背模板，而模板有好几个版本，互相矛盾。

真正管用的是盯住一个不变量：答案始终在 `[lo, hi]` 这个闭区间里。

## 标准形态

```python
def search(nums: list[int], target: int) -> int:
    lo, hi = 0, len(nums) - 1        # 闭区间，hi 是有效索引

    while lo <= hi:                   # 区间非空就继续
        mid = lo + (hi - lo) // 2     # 防溢出写法
        if nums[mid] == target:
            return mid
        elif nums[mid] < target:
            lo = mid + 1              # mid 已排除
        else:
            hi = mid - 1              # mid 已排除
    return -1
```

三处细节都由闭区间这个前提推出来，不需要单独记：

1. `hi = len(nums) - 1` —— 因为 `hi` 必须是能取到的索引。
2. `while lo <= hi` —— 因为 `lo == hi` 时区间里还有一个元素，不能跳过。
3. `mid ± 1` —— 因为 `mid` 已经比较过了，留在区间里会死循环。

## 为什么是 `lo + (hi - lo) // 2`

`(lo + hi) // 2` 在 lo 和 hi 都接近整型上限时会溢出。Python 的整数无上限，所以这里纯属习惯；但在 Java、C++、Go 里这是真实存在过的 bug —— JDK 的 `binarySearch` 就栽过。

## 复杂度

每轮把区间砍半，第 $k$ 轮后剩余规模为 $n / 2^k$。区间空掉时 $k$ 满足

$$
\frac{n}{2^k} < 1 \implies k > \log_2 n
$$

所以是 $O(\log n)$。对 $n = 10^9$，最多 30 次比较 —— 这个量级感受一下就明白为什么二分值得写对。

## 真正的坑：找边界而非找值

找第一个 >= target 的位置，这件事比找相等更常用，而且更容易写错：

```python
def lower_bound(nums: list[int], target: int) -> int:
    lo, hi = 0, len(nums)             # 注意：开区间，hi 可以等于 len
    while lo < hi:                    # 注意：严格小于
        mid = lo + (hi - lo) // 2
        if nums[mid] < target:
            lo = mid + 1
        else:
            hi = mid                  # 注意：不是 mid - 1
    return lo
```

这里换成了左闭右开 `[lo, hi)`，于是三处细节全都跟着变。混用两种区间约定是我以前所有 bug 的根源。

结论对我自己是：先声明用哪种区间，再推边界。不要背模板。
