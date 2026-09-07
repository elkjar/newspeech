#include "GlitchLaneGrid.h"
#include "NewspeechColors.h"

using namespace newspeech::colors;
using namespace glitch;

GlitchLaneGrid::GlitchLaneGrid (GlitchProcessor& p) : proc (p)
{
    setMouseCursor (juce::MouseCursor::CrosshairCursor);
}

Block* GlitchLaneGrid::findBlock (int lane, int id)
{
    if (lane < 0 || id < 0) return nullptr;
    auto& l = proc.pattern().lanes[(size_t) lane];
    for (int i = 0; i < l.count; ++i) if (l.blocks[(size_t) i].id == id) return &l.blocks[(size_t) i];
    return nullptr;
}

GlitchLaneGrid::Hit GlitchLaneGrid::hitTest (juce::Point<int> pt) const
{
    Hit h;
    const auto g = gridArea();
    const int lane = (pt.y - rulerH) / laneH;
    if (pt.y < rulerH || lane < 0 || lane >= numStages) return h;
    h.lane = lane;
    if (pt.x < labelW) { h.onDot = pt.x < 22; h.onLabel = ! h.onDot; return h; }
    auto& p = const_cast<GlitchProcessor&> (proc).pattern();
    const double fx = juce::jlimit (0.0, 1.0, (double) (pt.x - g.getX()) / g.getWidth());
    h.cellF = fx * p.grid;
    auto& l = p.lanes[(size_t) lane];
    const double cellW = (double) g.getWidth() / p.grid;
    constexpr int EDGE_PX = 6;
    Block* nearest = nullptr; double nearD = 1e9;
    for (int i = 0; i < l.count; ++i)
    {
        auto& b = l.blocks[(size_t) i];
        const double xa = g.getX() + b.a * cellW, xb = g.getX() + b.b * cellW;
        const double wpx = xb - xa;
        const double ez = wpx >= 4 * EDGE_PX ? EDGE_PX : juce::jmax (2.0, wpx / 4);
        if (pt.x >= xa - ez && pt.x <= xa + ez) { h.block = &b; h.edge = -1; return h; }
        if (pt.x >= xb - ez && pt.x <= xb + ez) { h.block = &b; h.edge = 1; return h; }
        if (pt.x > xa && pt.x < xb) { h.block = &b; return h; }
        const double d = pt.x < xa ? xa - pt.x : pt.x - xb;
        if (d < nearD) { nearD = d; nearest = &b; }
    }
    if (nearest != nullptr && nearD <= 4) h.block = nearest;   // near-miss grab on narrow blocks
    return h;
}

void GlitchLaneGrid::edited()
{
    if (onEdit) onEdit();
    repaint();
}

void GlitchLaneGrid::mouseDown (const juce::MouseEvent& e)
{
    if (liveDrifted && live != nullptr) { proc.adoptLive (*live); liveDrifted = false; selBlock = -1; }
    const auto h = hitTest (e.getPosition());
    if (h.lane < 0) return;
    auto& p = proc.pattern();
    auto& lane = p.lanes[(size_t) h.lane];
    if (h.onDot) { lane.on = ! lane.on; edited(); return; }
    if (h.onLabel) { selLane = h.lane; selBlock = -1; if (onSelect) onSelect (selLane, -1); repaint(); return; }

    const bool erase = e.mods.isRightButtonDown() || e.mods.isAltDown();
    if (erase)
    {
        if (h.block != nullptr)
        {
            const int id = h.block->id;
            int out = 0;
            for (int i = 0; i < lane.count; ++i) if (lane.blocks[(size_t) i].id != id) lane.blocks[(size_t) out++] = lane.blocks[(size_t) i];
            lane.count = out;
            selLane = h.lane; selBlock = -1;
            if (onSelect) onSelect (selLane, -1);
            edited();
        }
        return;
    }
    if (! e.mods.isLeftButtonDown()) return;
    if (h.block != nullptr && h.edge != 0)
    {
        drag = { h.edge < 0 ? Drag::edgeA : Drag::edgeB, h.lane, h.block->id, 0, h.block->a, h.block->b, 0.0 };
        selLane = h.lane; selBlock = h.block->id;
    }
    else if (h.block != nullptr)
    {
        drag = { Drag::move, h.lane, h.block->id, 0, h.block->a, h.block->b, h.cellF - h.block->a };
        selLane = h.lane; selBlock = h.block->id;
    }
    else
    {
        if (lane.count >= maxBlocks) return;
        const int cell = juce::jmin (p.grid - 1, (int) std::floor (h.cellF));
        auto b = makeBlock (p, h.lane, cell, cell + 1);
        lane.blocks[(size_t) lane.count++] = b;
        drag = { Drag::draw, h.lane, b.id, cell, cell, cell + 1, 0.0 };
        selLane = h.lane; selBlock = b.id;
    }
    if (onSelect) onSelect (selLane, selBlock);
    edited();
}

void GlitchLaneGrid::mouseDrag (const juce::MouseEvent& e)
{
    if (drag.kind == Drag::none) return;
    auto* b = findBlock (drag.lane, drag.blockId);
    if (b == nullptr) { drag.kind = Drag::none; return; }
    auto& p = proc.pattern();
    const auto g = gridArea();
    const double cellF = juce::jlimit (0.0, (double) p.grid, (double) (e.x - g.getX()) / g.getWidth() * p.grid);
    if (drag.kind == Drag::draw)
    {
        const int cell = juce::jlimit (0, p.grid - 1, (int) std::floor (cellF));
        b->a = juce::jmin (drag.anchorCell, cell);
        b->b = juce::jmax (drag.anchorCell, cell) + 1;
    }
    else if (drag.kind == Drag::edgeA) b->a = juce::jmin (b->b - 1, juce::jmax (0, juce::roundToInt (cellF)));
    else if (drag.kind == Drag::edgeB) b->b = juce::jmax (b->a + 1, juce::jmin (p.grid, juce::roundToInt (cellF)));
    else
    {
        const int len = drag.startB - drag.startA;
        const int a = juce::jlimit (0, p.grid - len, juce::roundToInt (cellF - drag.grabOff));
        b->a = a; b->b = a + len;
    }
    edited();
}

void GlitchLaneGrid::mouseUp (const juce::MouseEvent&)
{
    if (drag.kind == Drag::none) return;
    normalizeLane (proc.pattern().lanes[(size_t) drag.lane]);
    // the selected block may have been merged away — keep the one now covering it
    if (findBlock (drag.lane, drag.blockId) == nullptr)
    {
        auto& lane = proc.pattern().lanes[(size_t) drag.lane];
        selBlock = lane.count > 0 ? lane.blocks[0].id : -1;
        for (int i = 0; i < lane.count; ++i) if (lane.blocks[(size_t) i].a <= drag.startA && lane.blocks[(size_t) i].b >= drag.startB) selBlock = lane.blocks[(size_t) i].id;
    }
    drag.kind = Drag::none;
    if (onSelect) onSelect (selLane, selBlock);
    edited();
}

void GlitchLaneGrid::mouseDoubleClick (const juce::MouseEvent& e)
{
    if (liveDrifted && live != nullptr) { proc.adoptLive (*live); liveDrifted = false; }
    const auto h = hitTest (e.getPosition());
    if (h.block == nullptr) return;
    auto& p = proc.pattern();
    auto& lane = p.lanes[(size_t) h.lane];
    if (lane.count >= maxBlocks) return;
    // split at the nearest interior grid line
    const int cut = juce::roundToInt (h.cellF);
    if (cut <= h.block->a || cut >= h.block->b) return;
    Block right = *h.block;
    right.id = p.nextId++;
    right.a = cut;
    h.block->b = cut;
    lane.blocks[(size_t) lane.count++] = right;
    normalizeLane (lane);
    selLane = h.lane; selBlock = right.id;
    if (onSelect) onSelect (selLane, selBlock);
    edited();
}

void GlitchLaneGrid::mouseMove (const juce::MouseEvent& e)
{
    const auto h = hitTest (e.getPosition());
    if (h.lane < 0 || h.onLabel || h.onDot) setMouseCursor (juce::MouseCursor::PointingHandCursor);
    else if (h.block != nullptr) setMouseCursor (h.edge != 0 ? juce::MouseCursor::LeftRightResizeCursor : juce::MouseCursor::DraggingHandCursor);
    else setMouseCursor (juce::MouseCursor::CrosshairCursor);
}

void GlitchLaneGrid::paint (juce::Graphics& gfx)
{
    auto& p = proc.pattern();
    const auto g = gridArea().toFloat();
    const float W = g.getWidth();
    const int grid = juce::jmax (1, p.grid);
    const int cpb = proc.cellsPerBar();
    const bool running = proc.audioRunning();
    const double ph = running ? proc.engine().uiFrac() : -1.0;

    gfx.setColour (surface);
    gfx.fillRect (g);

    // ruler: bar numbers, and PASS n at the right
    gfx.setFont (monoFont (type::heading, type::headingTracking));
    gfx.setColour (white (alpha::heading));
    for (int bar = 0; bar * cpb < grid; ++bar)
        gfx.drawText (juce::String (bar + 1), juce::roundToInt (g.getX() + (float) bar * cpb / grid * W) + 4, 0, 40, rulerH, juce::Justification::centredLeft, false);
    if (running)
        gfx.drawText ("PASS " + juce::String (proc.engine().uiPass()), getLocalBounds().withHeight (rulerH).withTrimmedRight (4), juce::Justification::centredRight, false);

    // lane separators + grid lines: cells faint, beats brighter, bars brightest
    gfx.setColour (white (0.05f));
    for (int i = 1; i < numStages; ++i) gfx.fillRect (g.getX(), (float) (rulerH + i * laneH), W, 1.0f);
    const int beatCells = juce::jmax (1, cpb / 4);
    for (int c = 1; c < grid; ++c)
    {
        const float a = c % cpb == 0 ? 0.16f : c % beatCells == 0 ? 0.09f : 0.04f;
        gfx.setColour (white (a));
        gfx.fillRect ((float) juce::roundToInt (g.getX() + (float) c / grid * W), g.getY(), 1.0f, g.getHeight());
    }

    const bool drifted = liveDrifted && live != nullptr;
    for (int s = 0; s < numStages; ++s)
    {
        const auto& lane = p.lanes[(size_t) s];
        const float y = (float) (rulerH + s * laneH);
        // label column: dot + name
        const bool selL = s == selLane;
        const float r = 3.5f, cx = 11.0f, cy = y + laneH * 0.5f;
        if (lane.on) { gfx.setColour (white (alpha::full)); gfx.fillEllipse (cx - r, cy - r, 2 * r, 2 * r); }
        else { gfx.setColour (white (alpha::ring)); gfx.drawEllipse (cx - r, cy - r, 2 * r, 2 * r, 1.0f); }
        gfx.setFont (monoFont (type::label, type::labelTracking));
        gfx.setColour (white (selL ? alpha::full : lane.on ? alpha::dim : alpha::ring));
        gfx.drawText (stageSpec (s).name, 22, (int) y, labelW - 26, laneH, juce::Justification::centredLeft, false);

        const bool engaged = running && proc.engine().uiEng (s) > 0.5f;
        for (int i = 0; i < lane.count; ++i)
        {
            const auto& b = lane.blocks[(size_t) i];
            const float x0 = g.getX() + (float) b.a / grid * W, x1 = g.getX() + (float) b.b / grid * W;
            const bool sel = selL && b.id == selBlock;
            const float base = ! lane.on ? 0.08f : sel ? 0.55f : 0.28f;
            const juce::Rectangle<float> rc (x0 + 1, y + 4, juce::jmax (2.0f, x1 - x0 - 2), (float) laneH - 8);
            gfx.setColour (white (drifted ? base * 0.4f : base));
            gfx.fillRect (rc);
            if (engaged && ! drifted && ph >= (double) b.a / grid && ph < (double) b.b / grid)
            {
                gfx.setColour (white (0.18f));
                gfx.fillRect (rc);
            }
            if (sel) { gfx.setColour (white (0.9f)); gfx.drawRect (rc, 1.0f); }
            // per-block switch label (DRIVE / GLITCH mode) inside the block
            const auto& st = stageSpec (s);
            for (int k = 0; k < st.numSegs; ++k)
                if (st.segs[k].onBlock)
                {
                    const int opt = juce::jlimit (0, st.segs[k].count - 1, b.vals.seg[(size_t) k]);
                    gfx.saveState();
                    gfx.reduceClipRegion (juce::Rectangle<int> ((int) x0 + 6, (int) y, juce::jmax (0, (int) (x1 - x0) - 10), laneH));
                    gfx.setFont (monoFont (type::heading, 0.04f));
                    gfx.setColour (lane.on ? (sel ? ink : ink.withAlpha (0.9f)) : white (0.25f));
                    gfx.drawText (st.segs[k].names[opt], (int) x0 + 6, (int) y, 200, laneH, juce::Justification::centredLeft, false);
                    gfx.restoreState();
                }
            // accumulator mark: a notch bottom-right
            if (b.acc.shape != accOff) { gfx.setColour (lane.on ? ink : ink.withAlpha (0.6f)); gfx.fillRect (x1 - 6, y + laneH - 9, 3.0f, 3.0f); }
        }
    }

    // live (mutated) blocks: outlined, over the dimmed authored ones
    if (drifted)
        for (int s = 0; s < numStages; ++s)
        {
            const float y = (float) (rulerH + s * laneH);
            const bool engaged = running && proc.engine().uiEng (s) > 0.5f;
            const auto& lv = live->lanes[(size_t) s];
            for (int i = 0; i < lv.count; ++i)
            {
                const auto& b = lv.blocks[i];
                const float x0 = g.getX() + (float) b.a * W, x1 = g.getX() + (float) b.b * W;
                const bool under = engaged && ph >= b.a && ph < b.b;
                const juce::Rectangle<float> rc (x0 + 1, y + 4, juce::jmax (2.0f, x1 - x0 - 2), (float) laneH - 8);
                gfx.setColour (white (under ? 0.45f : 0.22f));
                gfx.fillRect (rc);
                gfx.setColour (white (0.7f));
                gfx.drawRect (rc, 1.0f);
            }
        }

    if (ph >= 0.0)
    {
        gfx.setColour (white (1.0f));
        gfx.fillRect ((float) juce::roundToInt (g.getX() + (float) ph * W), g.getY(), 1.0f, g.getHeight());
    }

    gfx.setColour (border);
    gfx.drawRect (g, 1.0f);
}
